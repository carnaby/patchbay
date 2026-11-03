import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrivateHosts, parsePrivateHosts } from './private-hosts.ts';
import {
  checkUrl,
  guardedLookup,
  type HopMode,
  type Resolver,
  redirectTarget,
  safeFetchJson,
  safeFetchText,
  URL_MESSAGES,
} from './safe-fetch.ts';

const hosts = parsePrivateHosts('homeassistant.lan, 192.168.1.0/24')!;

/** Runs the guarded lookup against a fake DNS answer; resolves to "ok" or the error code. */
function lookup(mode: HopMode, privateHosts: PrivateHosts | null, host: string, ...ips: string[]) {
  const resolve: Resolver = (_host, _options, callback) =>
    callback(
      null,
      ips.map((address) => ({ address, family: isIP(address) })),
    );
  return new Promise<string>((done) =>
    guardedLookup(mode, privateHosts, resolve)(host, { all: true }, (err) =>
      done(err ? ((err as NodeJS.ErrnoException).code ?? 'error') : 'ok'),
    ),
  );
}

describe('the guarded lookup', () => {
  it('keeps the public rules without a list, and on public hops', async () => {
    expect(await lookup('public', null, 'api.example.com', '93.184.216.34')).toBe('ok');
    expect(await lookup('public', null, 'api.example.com', '192.168.1.5')).toBe('EBLOCKED');
    expect(await lookup('public', hosts, 'homeassistant.lan', '192.168.1.5')).toBe('EBLOCKED');
  });

  it('lets a listed name resolve only into ordinary LAN ranges (DNS rebinding)', async () => {
    expect(await lookup('lan', hosts, 'homeassistant.lan', '10.0.0.7')).toBe('ok');
    expect(await lookup('lan', hosts, 'HomeAssistant.LAN.', 'fd12::7')).toBe('ok');
    for (const ip of [
      '127.0.0.1',
      '::1',
      '169.254.169.254',
      '169.254.1.1',
      'fe80::1',
      '0.0.0.0',
      'fd00:ec2::254',
      '64:ff9b::7f00:1',
      '8.8.8.8',
      '::ffff:127.0.0.1',
    ]) {
      expect([ip, await lookup('lan', hosts, 'homeassistant.lan', ip)]).toEqual([ip, 'EBLOCKED']);
    }
  });

  it('lets any name reach an address a range covers, in any spelling', async () => {
    expect(await lookup('lan', hosts, 'proxmox.home.arpa', '192.168.1.10')).toBe('ok');
    expect(await lookup('lan', hosts, 'proxmox.home.arpa', '::ffff:192.168.1.10')).toBe('ok');
    expect(await lookup('lan', hosts, 'proxmox.home.arpa', '10.0.0.1')).toBe('EBLOCKED');
  });

  it('blocks a whole answer when one address is not allowed', async () => {
    expect(await lookup('lan', hosts, 'homeassistant.lan', '10.0.0.7', '127.0.0.1')).toBe('EBLOCKED');
    expect(await lookup('mixed', hosts, 'api.example.com', '93.184.216.34', '10.0.0.7')).toBe('EBLOCKED');
  });

  it('never sends plain http or another port to a public address, but lets https on 443 reach both', async () => {
    expect(await lookup('lan', hosts, 'unlisted.example', '93.184.216.34')).toBe('EBLOCKED');
    expect(await lookup('mixed', hosts, 'unlisted.example', '93.184.216.34')).toBe('ok');
    expect(await lookup('mixed', hosts, 'nas.example', '192.168.1.20')).toBe('ok');
  });
});

describe('URL checks', () => {
  it('answers like a public instance without a list, with messages that name the setting', () => {
    expect(() => checkUrl('http://example.com/data.json')).toThrow(URL_MESSAGES.httpOff);
    expect(() => checkUrl('https://example.com:8443/x')).toThrow(URL_MESSAGES.portOff);
    expect(() => checkUrl('https://192.168.1.10/x')).toThrow(URL_MESSAGES.privateOff);
    expect(() => checkUrl('https://3232235786/x')).toThrow(URL_MESSAGES.privateOff);
    expect(checkUrl('https://example.com/x').mode).toBe('public');
  });

  it('classifies hops when a list is passed', () => {
    expect(checkUrl('http://homeassistant.lan:8123/api/states', hosts).mode).toBe('lan');
    expect(checkUrl('https://proxmox.home.arpa:8006/', hosts).mode).toBe('lan');
    expect(checkUrl('https://api.example.com/', hosts).mode).toBe('mixed');
    expect(checkUrl('http://192.168.1.10:9090/', hosts).mode).toBe('lan');
    expect(checkUrl('http://3232235786:9090/', hosts).url.hostname).toBe('192.168.1.10');
    expect(checkUrl('https://8.8.8.8/', hosts).mode).toBe('public');
  });

  it('refuses literals the list does not cover, in every spelling', () => {
    for (const [url, host] of [
      ['http://192.168.2.1/', '192.168.2.1'],
      ['http://3232236033/', '192.168.2.1'],
      ['http://0300.0250.2.1/', '192.168.2.1'],
      ['http://[::ffff:c0a8:201]/', '::ffff:c0a8:201'],
      ['https://127.0.0.1/', '127.0.0.1'],
      ['http://0x7f.1/', '127.0.0.1'],
      ['https://169.254.169.254/', '169.254.169.254'],
      ['http://8.8.8.8/', '8.8.8.8'],
    ] as const) {
      expect(() => checkUrl(url, hosts), url).toThrow(URL_MESSAGES.notListed(host));
    }
  });

  it('opens a metadata address only for an entry naming it exactly', () => {
    expect(() => checkUrl('http://169.254.169.254/', parsePrivateHosts('169.254.0.0/16'))).toThrow(
      /not covered/,
    );
    expect(checkUrl('http://169.254.169.254/', parsePrivateHosts('169.254.169.254')).mode).toBe('lan');
  });

  it('refuses a redirect from https:// down to http://, even into the list', () => {
    expect(() => redirectTarget(new URL('https://example.com/a'), 'http://192.168.1.10/x', hosts)).toThrow(
      URL_MESSAGES.downgrade,
    );
    expect(redirectTarget(new URL('http://192.168.1.10/a'), '/b', hosts).url.href).toBe(
      'http://192.168.1.10/b',
    );
    expect(() => redirectTarget(new URL('http://192.168.1.10/a'), 'http://192.168.2.1/', hosts)).toThrow(
      URL_MESSAGES.notListed('192.168.2.1'),
    );
  });
});

describe('fetching from a listed address for real', () => {
  // One policy object for the whole block: safe-fetch keeps one pair of agents per policy.
  const local = parsePrivateHosts('127.0.0.1')!;
  let server: Server;
  let port = 0;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const redirect = (to: string) => {
        res.writeHead(302, { location: to });
        res.end();
      };
      if (req.url === '/data') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[{"a":1}]');
      } else if (req.url === '/feed') {
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        res.end('<rss/>');
      } else if (req.url === '/to-data') redirect('/data');
      else if (req.url === '/to-other') redirect(`http://127.0.0.2:${port}/data`);
      else if (req.url === '/to-metadata') redirect('http://169.254.169.254/latest/meta-data/');
      else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('loads JSON and text over http:// from a listed address, following redirects on it', async () => {
    expect(await safeFetchJson(`${base}/data`, { privateHosts: local })).toEqual([{ a: 1 }]);
    expect(await safeFetchJson(`${base}/to-data`, { privateHosts: local })).toEqual([{ a: 1 }]);
    expect((await safeFetchText(`${base}/feed`, { accept: '*/*', privateHosts: local })).text).toBe('<rss/>');
  });

  it('stops a redirect to an address the list does not cover', async () => {
    await expect(safeFetchJson(`${base}/to-other`, { privateHosts: local })).rejects.toThrow(
      URL_MESSAGES.notListed('127.0.0.2'),
    );
    await expect(safeFetchJson(`${base}/to-metadata`, { privateHosts: local })).rejects.toThrow(
      URL_MESSAGES.notListed('169.254.169.254'),
    );
  });

  it('stays strict for every caller that does not pass the list (OAuth client documents)', async () => {
    await expect(safeFetchJson(`${base}/data`)).rejects.toThrow(URL_MESSAGES.httpOff);
    await expect(safeFetchJson(`${base}/data`, { privateHosts: null })).rejects.toThrow(URL_MESSAGES.httpOff);
    await expect(safeFetchText(`${base}/feed`, { accept: '*/*' })).rejects.toThrow(URL_MESSAGES.httpOff);
  });
});
