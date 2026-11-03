import { describe, expect, it } from 'vitest';
import { canonicalIp, PrivateHostsError, parsePrivateHosts, privateHostsNotice } from './private-hosts.ts';

const parse = (raw: string) => parsePrivateHosts(raw)!;

describe('parsePrivateHosts', () => {
  it('is off for an empty or blank value', () => {
    expect(parsePrivateHosts(undefined)).toBeNull();
    expect(parsePrivateHosts('')).toBeNull();
    expect(parsePrivateHosts(' , ,')).toBeNull();
  });

  it('keeps every entry in its canonical spelling', () => {
    expect(
      parse(
        ' HomeAssistant.LAN., *.Home.Arpa 192.168.1.0/24,10.0.0.5, [FD00::1], ::ffff:192.168.1.7, bücher.lan, fd00::/8',
      ).entries,
    ).toEqual([
      'homeassistant.lan',
      '*.home.arpa',
      '192.168.1.0/24',
      '10.0.0.5',
      'fd00::1',
      '192.168.1.7',
      'xn--bcher-kva.lan',
      'fd00::/8',
    ]);
  });

  it('stores a range by its network address', () => {
    expect(parse('192.168.1.77/24, FD00:1:0:0:5::7/64').entries).toEqual(['192.168.1.0/24', 'fd00:1::/64']);
  });

  it('refuses entries it cannot use, saying what to write', () => {
    const refusals: [string, RegExp][] = [
      ['http://nas.lan', /without http:\/\//],
      ['nas.lan:8123', /without http:\/\/ or a port/],
      ['nas.lan/api', /not a CIDR range/],
      ['0.0.0.0', /not a host address/],
      ['::', /not a host address/],
      ['224.0.0.1', /not a host address/],
      ['0.0.0.0/0', /too broad/],
      ['10.0.0.0/7', /too broad/],
      ['::/0', /too broad/],
      ['192.168.1.0/33', /not a CIDR range/],
      ['::ffff:192.168.1.0/120', /not a CIDR range/],
      ['localhost', /127\.0\.0\.1/],
      ['*.localhost', /127\.0\.0\.1/],
      ['3232235786', /write 192\.168\.1\.10/],
      ['0x7f.1', /write 127\.0\.0\.1/],
      ['192.168.001.010', /write 192\.168\.1\.8/],
      ['*', /not a host name/],
      ['fe80::1%eth0', /not a host name/],
      ['192.168.1.5:80', /has a port/],
      ['[fd00::1]:8080', /has a port/],
      ['nas.lan:', /has a port/],
      ['user@10.0.0.1', /user name/],
      ['*.1', /last label is numeric/],
      ['::1/64', /IPv4 instead/],
      ['::/8', /IPv4 instead/],
      ['::/7', /IPv4 instead/],
      ['169.254.169.254/32', /list the exact address 169\.254\.169\.254/],
      ['fd20:ce::254/128', /list the exact address fd20:ce::254/],
    ];
    for (const [entry, message] of refusals) {
      expect(() => parsePrivateHosts(entry), entry).toThrow(PrivateHostsError);
      expect(() => parsePrivateHosts(entry), entry).toThrow(message);
    }
  });
});

describe('canonicalIp', () => {
  it('gives one spelling per address and unwraps only IPv4-mapped IPv6', () => {
    expect(canonicalIp('[FD00:0:0::1]')).toBe('fd00::1');
    expect(canonicalIp('::ffff:192.168.1.7')).toBe('192.168.1.7');
    expect(canonicalIp('::ffff:c0a8:107')).toBe('192.168.1.7');
    expect(canonicalIp('64:ff9b::c0a8:107')).toBe('64:ff9b::c0a8:107');
    expect(canonicalIp('fe80::1%eth0')).toBeNull();
    expect(canonicalIp('nas.lan')).toBeNull();
  });
});

describe('matching', () => {
  const hosts = parse('homeassistant.lan, *.home.arpa, 192.168.1.0/24, 10.0.0.5, fd00:1::/64');

  it('lists names exactly or below a wildcard, whatever the case or a trailing dot', () => {
    for (const host of ['homeassistant.lan', 'HomeAssistant.LAN.', 'pve.home.arpa', 'a.b.home.arpa'])
      expect(hosts.listsHost(host), host).toBe(true);
    for (const host of ['home.arpa', 'xhome.arpa', 'homeassistant.lan.evil.example', 'nas.lan'])
      expect(hosts.listsHost(host), host).toBe(false);
  });

  it('lists IP literals an address entry covers, in any spelling', () => {
    for (const host of [
      '192.168.1.77',
      '[::ffff:192.168.1.77]',
      '::ffff:c0a8:14d',
      '10.0.0.5',
      '[fd00:1::9]',
    ])
      expect(hosts.listsHost(host), host).toBe(true);
    for (const host of ['192.168.2.1', '10.0.0.6', '127.0.0.1', 'fd00:2::1'])
      expect(hosts.listsHost(host), host).toBe(false);
  });

  it('lets a listed name reach only ordinary LAN ranges', () => {
    for (const ip of [
      '10.1.2.3',
      '172.20.0.2',
      '192.168.50.1',
      '100.101.102.103',
      'fd12::1',
      '::ffff:10.1.2.3',
    ])
      expect(hosts.allowsAddress('homeassistant.lan', ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '::1',
      '169.254.169.254',
      '169.254.10.10',
      'fe80::1',
      '0.0.0.0',
      '::',
      'fd00:ec2::254',
      '100.100.100.200',
      'fd20:ce::254',
      '64:ff9b::a01:203',
      '8.8.8.8',
      '2606:4700::1111',
      '224.0.0.251',
    ])
      expect(hosts.allowsAddress('homeassistant.lan', ip), ip).toBe(false);
  });

  it('lets any name reach an address that an address entry covers', () => {
    expect(hosts.allowsAddress('proxmox.example', '192.168.1.10')).toBe(true);
    expect(hosts.allowsAddress('proxmox.example', '::ffff:192.168.1.10')).toBe(true);
    expect(hosts.allowsAddress('proxmox.example', '10.0.0.6')).toBe(false);
    expect(hosts.allowsAddress('proxmox.example', '172.20.0.2')).toBe(false);
  });

  it('keeps IPv6 ranges from matching IPv4 addresses', () => {
    const v6 = parse('fd00::/8, ::1');
    for (const ip of ['127.0.0.1', '192.168.1.1', '8.8.8.8', '169.254.10.10'])
      expect(v6.allowsAddress('x', ip), ip).toBe(false);
    expect(v6.listsHost('8.8.8.8')).toBe(false);
    expect(parse('192.168.1.0/24').allowsAddress('x', 'fd00::1')).toBe(false);
  });

  it('opens loopback only through an address entry, and metadata only through its exact address', () => {
    const local = parse('127.0.0.0/8, 169.254.0.0/16');
    expect(local.allowsAddress('x', '127.0.0.1')).toBe(true);
    expect(local.allowsAddress('x', '169.254.10.10')).toBe(true);
    expect(local.allowsAddress('x', '169.254.169.254')).toBe(false);
    expect(local.allowsAddress('x', '0.0.0.0')).toBe(false);
    expect(parse('169.254.169.254').allowsAddress('x', '169.254.169.254')).toBe(true);
    expect(parse('fd00::/8').allowsAddress('x', 'fd00:ec2::254')).toBe(false);
  });
});

describe('privateHostsNotice', () => {
  const hosts = parse('192.168.1.0/24, homeassistant.lan');

  it('says nothing without a list', () => {
    expect(privateHostsNotice(null, 'everyone', { googleSignIn: false, admins: 0 })).toEqual([]);
  });

  it('says what is open and to whom, and warns when it is wide or has no effect', () => {
    expect(privateHostsNotice(hosts, 'admins', { googleSignIn: true, admins: 1 })).toEqual([
      'ALLOW_PRIVATE_HOSTS: dashboards owned by an administrator may load from 192.168.1.0/24, homeassistant.lan, also over http:// and on any port',
    ]);
    expect(privateHostsNotice(hosts, 'admins', { googleSignIn: false, admins: 1 })[1]).toMatch(
      /no effect.*PRIVATE_HOSTS_FOR=everyone/,
    );
    expect(privateHostsNotice(hosts, 'admins', { googleSignIn: true, admins: 0 })[1]).toMatch(
      /no effect.*ADMIN_EMAILS/,
    );
    expect(privateHostsNotice(hosts, 'signed-in', { googleSignIn: true, admins: 0 })[1]).toMatch(
      /anyone with a Google account/,
    );
    expect(privateHostsNotice(hosts, 'everyone', { googleSignIn: false, admins: 0 })[1]).toMatch(
      /anyone who reaches this server/,
    );
  });
});
