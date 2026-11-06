import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Credential, redact, redactJson, safeFetchJson, URL_MESSAGES } from './safe-fetch.ts';
import { APP_VERSION, USER_AGENT } from './version.ts';

/** A value with characters that encoders treat differently: "/", "+", "=", a space and "~". */
const VALUE = 'Ab/c+D=e f~g_12345';
const R = '[redacted]';

const pythonQuote = (s: string) =>
  // urllib.parse.quote: "/" stays raw, everything else outside unreserved is %XX.
  [...Buffer.from(s, 'utf8')]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9_.~/-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');

describe('echo redaction', () => {
  const leaks = (echo: unknown) => JSON.stringify(redactJson({ items: [{ echo }] }, [VALUE]));

  it('catches the spellings an API may echo a value in', () => {
    const echoes: Record<string, string> = {
      raw: `token=${VALUE}`,
      upperHex: `q=${encodeURIComponent(VALUE)}`,
      lowerHex: `q=${encodeURIComponent(VALUE).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`,
      form: new URLSearchParams({ q: VALUE }).toString(),
      pythonQuote: `/echo?q=${pythonQuote(VALUE)}`,
      doubleEncoded: `next=${encodeURIComponent(`https://x.example/?q=${encodeURIComponent(VALUE)}`)}`,
      upperCase: `TOKEN=${VALUE.toUpperCase()}`,
      lowerCase: `token=${VALUE.toLowerCase()}`,
      base64: Buffer.from(VALUE).toString('base64'),
      base64url: Buffer.from(VALUE).toString('base64url'),
      basicAuth: `Basic ${Buffer.from(`user:${VALUE}`).toString('base64')}`,
      basicAuth2: `Basic ${Buffer.from(`us:${VALUE}`).toString('base64')}`,
      basicAuth3: `Basic ${Buffer.from(`u:${VALUE}`).toString('base64url')}`,
      jsonInString: JSON.stringify({ token: VALUE }).replace(/\//g, '\\/'),
      unicodeEscaped: `{"token":"${[...VALUE].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"}`,
    };
    for (const [name, echo] of Object.entries(echoes)) {
      const out = redactJson({ [echo]: echo }, [VALUE]) as Record<string, string>;
      const [key, value] = Object.entries(out)[0]!;
      for (const shown of [key, value]) {
        expect(shown, name).toContain(R);
        expect(shown.toLowerCase(), name).not.toContain(VALUE.toLowerCase());
        expect(shown, name).not.toContain(Buffer.from(VALUE).toString('base64').slice(0, 12));
      }
    }
  });

  it('catches numeric values, with or without leading zeros', () => {
    expect(leaks(VALUE)).not.toContain(VALUE);
    const out = redactJson({ a: 12345678901234, b: '0012345678901234' }, ['0012345678901234']);
    expect(out).toEqual({ a: R, b: R });
    // A digits-only value whose significant part is short does not turn ordinary numbers into "[redacted]".
    expect(redactJson({ n: 42 }, ['00000000000042'])).toEqual({ n: 42 });
  });

  it('keeps readable text around plain matches and leaves other data alone', () => {
    expect(redactJson({ auth: `Bearer ${VALUE}` }, [VALUE])).toEqual({ auth: `Bearer ${R}` });
    expect(redactJson({ auth: `Bearer ${VALUE.toUpperCase()}` }, [VALUE])).toEqual({ auth: `Bearer ${R}` });
    const data = {
      city: 'Bratislava',
      note: 'Ľudovít Štúr, 100% sure + more / less',
      when: '2026-10-26T12:00:00Z',
      n: 3.14,
      ok: true,
      none: null,
      list: ['a+b', 'c%2Fd', 'QWJjZGVm'],
    };
    expect(redactJson(data, [VALUE])).toEqual(data);
  });

  it('redacts messages the same way', () => {
    expect(redact(`failed for ${encodeURIComponent(VALUE).toLowerCase()}`, [VALUE])).not.toMatch(/ab%2fc/i);
    expect(redact(`plain ${VALUE} text`, [VALUE])).toBe(`plain ${R} text`);
  });
});

describe('small documents', () => {
  let server: Server;
  let dispatcher: Agent;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/large') return res.end(JSON.stringify({ pad: 'x'.repeat(20_000) }));
      if (req.url === '/ua') return res.end(JSON.stringify({ ua: req.headers['user-agent'] }));
      if (req.url === '/many') return res.end(JSON.stringify(Array.from({ length: 1000 }, (_, i) => i)));
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    dispatcher = new Agent({
      connect: (_options, callback) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => callback(null, socket));
        socket.once('error', (e) => callback(e, null));
      },
    });
  });

  afterAll(async () => {
    await dispatcher.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('holds a response to the byte and value limits the caller sets', async () => {
    const options = { maxBytes: 16 * 1024, maxValues: 256, test: { dispatcher } };
    await expect(safeFetchJson('https://small.example/ok', options)).resolves.toEqual({ ok: true });
    await expect(safeFetchJson('https://small.example/large', options)).rejects.toThrow(
      'Response larger than 16 KB',
    );
    await expect(safeFetchJson('https://small.example/many', options)).rejects.toThrow(
      'The response holds more than 256 values',
    );
    // Without them, the defaults apply.
    await expect(safeFetchJson('https://small.example/many', { test: { dispatcher } })).resolves.toHaveLength(
      1000,
    );
  });

  it('names the running release in its user agent', async () => {
    const [major, minor] = APP_VERSION.split('.');
    expect(USER_AGENT).toBe(`Patchbay/${major}.${minor} (+https://github.com/carnaby/patchbay)`);
    await expect(safeFetchJson('https://small.example/ua', { test: { dispatcher } })).resolves.toEqual({
      ua: USER_AGENT,
    });
  });
});

describe('POST', () => {
  let server: Server;
  let dispatcher: Agent;
  const received: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const since = (mark: number) => received.slice(mark);
  const ANSWER = { data: { viewer: { login: 'octo' } } };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (req.url === '/v1/moved-307' || req.url === '/v1/moved-302') {
          res.writeHead(req.url.endsWith('307') ? 307 : 302, { location: '/v1/graphql' });
          return res.end();
        }
        if (req.url === '/v1/to-metadata') {
          res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ANSWER));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    dispatcher = new Agent({
      connect: (_options, callback) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => callback(null, socket));
        socket.once('error', (e) => callback(e, null));
      },
    });
  });

  afterAll(async () => {
    await dispatcher.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('sends the body as JSON with its content type', async () => {
    const mark = received.length;
    const body = { query: '{ viewer { login } }', variables: { n: 1 } };
    await expect(
      safeFetchJson('https://api.example.com/v1/graphql', { method: 'POST', body, test: { dispatcher } }),
    ).resolves.toEqual(ANSWER);
    const sent = since(mark);
    expect(sent.map((r) => [r.method, r.url, r.body])).toEqual([
      ['POST', '/v1/graphql', JSON.stringify(body)],
    ]);
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(sent[0]!.headers.accept).toBe('application/json');
  });

  it('sends an empty POST without a content type, and a GET exactly as before', async () => {
    const mark = received.length;
    await safeFetchJson('https://api.example.com/v1/empty', { method: 'POST', test: { dispatcher } });
    await safeFetchJson('https://api.example.com/v1/get', { test: { dispatcher } });
    const [empty, get] = since(mark);
    expect([empty!.method, empty!.body, empty!.headers['content-type']]).toEqual(['POST', '', undefined]);
    expect([get!.method, get!.body, get!.headers['content-type']]).toEqual(['GET', '', undefined]);
  });

  it('never follows a redirect of a POST: one request, then the error', async () => {
    for (const path of ['/v1/moved-307', '/v1/moved-302', '/v1/to-metadata']) {
      const start = received.length;
      await expect(
        safeFetchJson(`https://api.example.com${path}`, {
          method: 'POST',
          body: { q: 1 },
          test: { dispatcher },
        }),
        path,
      ).rejects.toThrow(URL_MESSAGES.postRedirect);
      expect(since(start).map((r) => [r.method, r.url])).toEqual([['POST', path]]);
    }
    // A GET still follows the same answer.
    const mark = received.length;
    await expect(
      safeFetchJson('https://api.example.com/v1/moved-302', { test: { dispatcher } }),
    ).resolves.toEqual(ANSWER);
    expect(since(mark).map((r) => [r.method, r.url])).toEqual([
      ['GET', '/v1/moved-302'],
      ['GET', '/v1/graphql'],
    ]);
  });

  it('keeps the address rules: nothing private, plain or on another port, and nothing sent', async () => {
    const mark = received.length;
    const refused: [string, string][] = [
      ['https://127.0.0.1/v1/graphql', URL_MESSAGES.privateOff],
      ['https://[::1]/v1/graphql', URL_MESSAGES.privateOff],
      ['https://169.254.169.254/latest/meta-data/', URL_MESSAGES.privateOff],
      ['http://api.example.com/v1/graphql', URL_MESSAGES.httpOff],
      ['https://api.example.com:8443/v1/graphql', URL_MESSAGES.portOff],
    ];
    for (const [url, message] of refused) {
      await expect(
        safeFetchJson(url, { method: 'POST', body: { q: 1 }, test: { dispatcher } }),
        url,
      ).rejects.toThrow(message);
    }
    expect(since(mark)).toEqual([]);
  });

  it('sends a secret only to its bound address, and stops a redirect after the first hop', async () => {
    const credential: Credential = {
      id: 'sec_AAAAAAAAAAAAAAAA',
      revision: 1,
      origin: 'https://api.example.com',
      pathPrefix: '/v1/',
      placement: 'header',
      paramName: 'X-API-Key',
      value: VALUE,
    };
    const post = { method: 'POST' as const, body: { q: 1 }, credentials: [credential], test: { dispatcher } };
    const mark = received.length;
    await expect(safeFetchJson('https://api.example.com/v1/graphql', post)).resolves.toEqual(ANSWER);
    await expect(safeFetchJson('https://api.example.com/v2/graphql', post)).rejects.toThrow(
      'Credentials for this source are bound to another address.',
    );
    await expect(safeFetchJson('https://api.example.com/v1/moved-307', post)).rejects.toThrow(
      URL_MESSAGES.postRedirect,
    );
    expect(since(mark).map((r) => [r.method, r.url, r.headers['x-api-key'], r.body])).toEqual([
      ['POST', '/v1/graphql', VALUE, '{"q":1}'],
      ['POST', '/v1/moved-307', VALUE, '{"q":1}'],
    ]);
  });
});
