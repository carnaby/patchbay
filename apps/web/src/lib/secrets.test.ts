import {
  applyOps,
  CONFIRM_PUBLIC_SECRETS,
  CREDENTIAL_ERRORS,
  type DashboardDoc,
  emptyDashboard,
  httpRequestKey,
  parameterRequestShape,
  type Source,
} from '@patchbay/core';
import { describe, expect, it } from 'vitest';
import {
  confirmedForSave,
  credentialErrorHint,
  credentialIssues,
  extractQueryParam,
  introducedSecretIds,
  introducedSecretRefs,
  joinNames,
  plainHttpWarning,
  publicSecretsRequest,
  type SecretListItem,
  secretRefNames,
  secretsSectionMode,
  suggestedSendTo,
} from './secrets.ts';

const A = 'sec_AAAAAAAAAAAAAAAA';
const B = 'sec_BBBBBBBBBBBBBBBB';

const secret = (id: string, extra: Partial<SecretListItem> = {}): SecretListItem => ({
  id,
  name: `Secret ${id.slice(4, 5)}`,
  origin: 'https://api.example.com',
  pathPrefix: '/v1/',
  placement: 'bearer',
  paramName: null,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  lastUsedAt: null,
  sentAs: 'Authorization: Bearer',
  ...extra,
});

const http = (url: string, secrets?: string[]): Source =>
  secrets ? { kind: 'http', url, secrets } : { kind: 'http', url };

function docWith(source: Source): DashboardDoc {
  return applyOps(emptyDashboard('T'), [
    {
      op: 'addDataset',
      dataset: { id: 'orders', name: 'Orders', source, transforms: [], refreshSec: 0, accumulate: 0 },
    },
  ]).doc;
}

describe('publicSecretsRequest', () => {
  it('reads the secrets of a 428 confirm_public_secrets answer', () => {
    const error = {
      status: 428,
      body: {
        code: CONFIRM_PUBLIC_SECRETS,
        secrets: [
          { id: A, name: 'Shop API' },
          { id: B, name: null },
        ],
      },
    };
    expect(publicSecretsRequest(error)).toEqual([
      { id: A, name: 'Shop API' },
      { id: B, name: null },
    ]);
  });

  it('ignores every other error, including other 428s and 409 conflicts', () => {
    expect(publicSecretsRequest({ status: 428, body: { code: 'other' } })).toBeNull();
    expect(publicSecretsRequest({ status: 409, body: { code: CONFIRM_PUBLIC_SECRETS } })).toBeNull();
    expect(publicSecretsRequest(new Error('boom'))).toBeNull();
    expect(publicSecretsRequest(null)).toBeNull();
  });
});

describe('confirmation of references on a public dashboard', () => {
  const plain = docWith(http('https://api.example.com/v1/orders'));
  const withA = docWith(http('https://api.example.com/v1/orders', [A]));

  it('fingerprints new and re-pointed references only', () => {
    expect(introducedSecretRefs(plain, withA)).toEqual([`orders https://api.example.com/v1/orders ${A}`]);
    expect(introducedSecretRefs(withA, withA)).toEqual([]);
    // Removing a reference sends nothing anywhere new.
    expect(introducedSecretRefs(withA, plain)).toEqual([]);
    expect(introducedSecretIds(plain, withA)).toEqual([A]);
  });

  it('sends the flag only for exactly what the user confirmed', () => {
    const refs = introducedSecretRefs(plain, withA);
    expect(confirmedForSave(plain, withA, [])).toBe(false);
    expect(confirmedForSave(plain, withA, refs)).toBe(true);
    // Pointing the confirmed secret at another URL asks again.
    const moved = docWith(http('https://api.example.com/v1/customers', [A]));
    expect(confirmedForSave(plain, moved, refs)).toBe(false);
    // Nothing introduced: no flag at all.
    expect(confirmedForSave(withA, withA, refs)).toBe(false);
  });

  it('asks again for another method or body, as the server does, but not for the order of its keys', () => {
    const url = 'https://api.example.com/v1/graphql';
    const post = (body: unknown): Source => ({ kind: 'http', url, secrets: [A], method: 'POST', body });
    const get = docWith(http(url, [A]));
    const stats = docWith(post({ query: '{ publicStats }', variables: { a: 1, b: 2 } }));
    const users = docWith(post({ query: '{ users { email apiKey } }' }));
    const toPost = introducedSecretRefs(get, stats);
    expect(toPost).toHaveLength(1);
    expect(confirmedForSave(get, stats, toPost)).toBe(true);
    // The confirmation of one query does not cover the next one.
    expect(introducedSecretRefs(stats, users)).toHaveLength(1);
    expect(confirmedForSave(stats, users, toPost)).toBe(false);
    expect(confirmedForSave(stats, get, toPost)).toBe(false);
    const reordered = docWith(post({ variables: { b: 2, a: 1 }, query: '{ publicStats }' }));
    expect(introducedSecretRefs(stats, reordered)).toEqual([]);
  });
});

describe('names in the dialog', () => {
  it('joins names and stands in for deleted secrets', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(secretRefNames([{ id: A, name: null }])).toEqual([`a deleted secret (${A})`]);
  });
});

describe('credentialIssues', () => {
  const context = { secrets: [secret(A)], mode: 'users' as const, canUseSecrets: true };

  it('has nothing to say about a matching secret or a source without secrets', () => {
    expect(credentialIssues(http('https://api.example.com/v1/orders', [A]), context)).toEqual([]);
    expect(credentialIssues(http('https://api.example.com/v1/orders'), context)).toEqual([]);
  });

  it('explains a binding mismatch while typing', () => {
    const [issue] = credentialIssues(http('https://other.example.com/v1/orders', [A]), context);
    expect(issue?.secretId).toBe(A);
    expect(issue?.message).toContain('only sent to https://api.example.com/v1/');
  });

  it('explains a deleted secret', () => {
    const [issue] = credentialIssues(http('https://api.example.com/v1/orders', [B]), context);
    expect(issue?.message).toBe(
      'The secret this dataset used no longer exists. Pick one of your secrets for api.example.com.',
    );
  });

  it('reports two secrets writing the same header', () => {
    const issues = credentialIssues(http('https://api.example.com/v1/orders', [A, B]), {
      ...context,
      secrets: [secret(A), secret(B)],
    });
    expect(issues.map((i) => i.message).join(' ')).toContain('would both set');
  });

  it('says secrets are off, or for admins only, and that they are kept', () => {
    const off = credentialIssues(http('https://api.example.com/v1/orders', [A]), {
      ...context,
      mode: 'off',
      canUseSecrets: false,
    });
    expect(off[0]?.message).toContain(CREDENTIAL_ERRORS.off);
    expect(off[0]?.message).toContain('Your secrets are kept');
    const admins = credentialIssues(http('https://api.example.com/v1/orders', [A]), {
      ...context,
      mode: 'admins',
      canUseSecrets: false,
    });
    expect(admins[0]?.message).toContain('only lets administrators');
  });
});

describe('credentialErrorHint', () => {
  const owner = { hasSecrets: true, canAddSecrets: true };

  it('adds detail to every generic credential error', () => {
    for (const message of Object.values(CREDENTIAL_ERRORS)) {
      expect(credentialErrorHint(message, owner)).toBeTruthy();
    }
    expect(credentialErrorHint(CREDENTIAL_ERRORS.undecryptable, owner)).toContain('Replace the value');
  });

  it('turns an upstream 401 into advice that fits the dataset', () => {
    expect(credentialErrorHint('Upstream responded 401 Unauthorized', owner)).toContain(
      'rejected the credential',
    );
    expect(
      credentialErrorHint('Upstream responded 403', { hasSecrets: false, canAddSecrets: true }),
    ).toContain('probably needs a secret');
    expect(
      credentialErrorHint('Upstream responded 401', { hasSecrets: false, canAddSecrets: false }),
    ).toBeNull();
    expect(credentialErrorHint('Upstream responded 500', owner)).toBeNull();
  });
});

describe('Settings section', () => {
  it('hides only when the switch is off and nothing is stored', () => {
    expect(secretsSectionMode({ mode: 'off', canUseSecrets: false, secrets: [] })).toBe('hidden');
    expect(secretsSectionMode({ mode: 'off', canUseSecrets: false, secrets: [secret(A)] })).toBe('cleanup');
    expect(secretsSectionMode({ mode: 'admins', canUseSecrets: false, secrets: [] })).toBe('cleanup');
    expect(secretsSectionMode({ mode: 'admins', canUseSecrets: true, secrets: [] })).toBe('manage');
    expect(secretsSectionMode({ mode: 'users', canUseSecrets: true, secrets: [] })).toBe('manage');
  });
});

describe('moving a key out of the URL', () => {
  it('suggests the origin as the address', () => {
    expect(suggestedSendTo('https://api.example.com/v1/x?key=1')).toBe('https://api.example.com/');
    expect(suggestedSendTo('http://api.example.com/')).toBe('http://api.example.com/');
    expect(suggestedSendTo('nonsense')).toBe('');
  });

  it('suggests http:// origins with their port (the server decides whether they may be bound)', () => {
    expect(suggestedSendTo('http://192.168.1.20:8123/api/states')).toBe('http://192.168.1.20:8123/');
  });

  it('warns before a value goes over plain http', () => {
    expect(plainHttpWarning({ origin: 'http://192.168.1.20:8123', pathPrefix: '/api/' })).toMatch(
      /unencrypted/,
    );
    expect(plainHttpWarning({ origin: 'https://api.example.com', pathPrefix: '/' })).toBeNull();
    expect(plainHttpWarning(null)).toBeNull();
  });

  it('removes the parameter and returns its value', () => {
    expect(
      extractQueryParam('https://api.example.com/v1/x?api_key=abc123456&city=Vienna', 'api_key'),
    ).toEqual({
      url: 'https://api.example.com/v1/x?city=Vienna',
      value: 'abc123456',
    });
    expect(extractQueryParam('https://api.example.com/v1/x?token=abcdefgh', 'token')).toEqual({
      url: 'https://api.example.com/v1/x',
      value: 'abcdefgh',
    });
    expect(extractQueryParam('https://api.example.com/v1/x', 'token')).toBeNull();
  });
});

describe('confirming filters on a public secret-backed source', () => {
  const region = {
    id: 'region',
    label: 'Region',
    type: 'select' as const,
    options: [{ value: 'eu' }, { value: 'us' }],
    all: 'All',
    default: null,
  };
  const prev = applyOps(emptyDashboard('t'), [
    { op: 'addParameter', parameter: region },
    {
      op: 'addDataset',
      dataset: {
        id: 'o',
        name: 'O',
        source: {
          kind: 'http',
          url: 'https://api.example.com/v1/orders?region=$param.region',
          secrets: ['sec_AAAAAAAAAAAAAAAA'],
        },
      },
    },
  ]).doc;
  const widen = (doc: typeof prev, value: string) =>
    applyOps(doc, [
      {
        op: 'updateParameter',
        id: 'region',
        set: { options: [...(doc.parameters![0] as typeof region).options, { value }] },
      },
    ]).doc;

  it('asks again for every change of the choices the request sends with the secret', () => {
    const once = widen(prev, 'apac');
    const confirmed = introducedSecretRefs(prev, once);
    expect(confirmed).toHaveLength(1);
    expect(confirmedForSave(prev, once, confirmed)).toBe(true);
    const twice = widen(once, 'latam');
    expect(confirmedForSave(once, twice, confirmed)).toBe(false);
  });

  it('fingerprints what a body-only source may send, and not the words around it', () => {
    const body = applyOps(emptyDashboard('t'), [
      { op: 'addParameter', parameter: region },
      {
        op: 'addDataset',
        dataset: {
          id: 'o',
          name: 'O',
          source: {
            kind: 'http',
            url: 'https://api.example.com/v1/orders',
            method: 'POST',
            body: { variables: { r: '$param.region' } },
            secrets: ['sec_AAAAAAAAAAAAAAAA'],
          },
        },
      },
    ]).doc;
    const [fingerprint] = introducedSecretRefs(emptyDashboard('t'), body);
    expect(fingerprint).toBe(
      `o https://api.example.com/v1/orders sec_AAAAAAAAAAAAAAAA ${httpRequestKey(body.datasets[0]!.source)} ${JSON.stringify([parameterRequestShape(body.parameters![0]!)])}`,
    );
    expect(fingerprint).toContain('"us"');
    expect(fingerprint).not.toContain('Region');
    const relabelled = applyOps(body, [
      {
        op: 'updateParameter',
        id: 'region',
        set: {
          label: 'Area',
          all: 'Everywhere',
          options: [{ value: 'eu', label: 'Europe' }, { value: 'us' }],
        },
      },
    ]).doc;
    expect(introducedSecretRefs(body, relabelled)).toEqual([]);
    expect(introducedSecretRefs(emptyDashboard('t'), relabelled)).toEqual([fingerprint]);
  });
});
