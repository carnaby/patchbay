import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redact, redactJson, safeFetchJson } from './safe-fetch.ts';

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
});
