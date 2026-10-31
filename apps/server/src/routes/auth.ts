/** Web sign-in: Google OAuth (OIDC) and a development-only passwordless login. */
import { decodeIdToken, Google, generateCodeVerifier, generateState } from 'arctic';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { SESSION_COOKIE } from '../auth/users.ts';
import { type Ctx, clientKey, type Deps, type Env } from '../context.ts';
import { badRequest, HttpError } from '../util/errors.ts';

const RETURN_FALLBACK = '/me';
// A placeholder origin: what matters is whether the value stays on the origin it is resolved against.
const RETURN_BASE = 'https://return-to.invalid';

/**
 * Only same-origin paths, so `returnTo` cannot become an open redirect. Browsers drop tabs and newlines and read
 * `\` as `/` when they resolve a Location header, so `/<tab>/evil.com` would leave the site. Anything with control
 * or invisible characters, whitespace or backslashes is refused, and the rest must resolve to a path on our origin.
 * Applied when the value arrives and again when it comes back from the cookie.
 */
export function safeReturnTo(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 500) return RETURN_FALLBACK;
  if (/[\s\\\p{Cc}\p{Cf}]/u.test(raw)) return RETURN_FALLBACK;
  let url: URL;
  try {
    url = new URL(raw, RETURN_BASE);
  } catch {
    return RETURN_FALLBACK;
  }
  if (url.origin !== RETURN_BASE) return RETURN_FALLBACK;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can normalise into a protocol-relative URL ("/.//evil.com" becomes "//evil.com").
  return path.startsWith('//') ? RETURN_FALLBACK : path;
}

export function authRoutes(deps: Deps) {
  const app = new Hono<Env>();
  const { config, users } = deps;
  const cookieBase = { httpOnly: true, secure: config.secureCookies, sameSite: 'Lax' as const, path: '/' };
  const google = config.google
    ? new Google(
        config.google.clientId,
        config.google.clientSecret,
        `${config.publicUrl}/auth/google/callback`,
      )
    : null;

  const startSession = (c: Ctx, userId: string) => {
    const session = users.createSession(userId);
    setCookie(c, SESSION_COOKIE, session.token, { ...cookieBase, expires: session.expires });
  };

  // Public and read-only: the sign-in page and the privacy page describe this instance with it. Settings only, no secrets.
  app.get('/config', (c) =>
    c.json({
      google: Boolean(google),
      devLogin: config.devLogin,
      offline: config.offline,
      pruneAnonymousAfterDays: config.pruneAnonymousAfterDays,
      pruneBlankAnonymousAfterHours: config.pruneBlankAnonymousAfterHours,
      analytics: Boolean(config.analytics),
    }),
  );

  app.get('/google', (c) => {
    if (!google) throw new HttpError(404, 'Google sign-in is not configured');
    if (!deps.limits.auth.take(`login:${clientKey(c, config.trustProxy)}`))
      throw new HttpError(429, 'Too many attempts');
    const state = generateState();
    const verifier = generateCodeVerifier();
    const url = google.createAuthorizationURL(state, verifier, ['openid', 'profile', 'email']);
    url.searchParams.set('prompt', 'select_account');
    const short = { ...cookieBase, maxAge: 600 };
    setCookie(c, 'pb_oauth_state', state, short);
    setCookie(c, 'pb_oauth_verifier', verifier, short);
    setCookie(c, 'pb_return_to', safeReturnTo(c.req.query('returnTo')), short);
    return c.redirect(url.toString());
  });

  app.get('/google/callback', async (c) => {
    if (!google) throw new HttpError(404, 'Google sign-in is not configured');
    const state = c.req.query('state');
    const code = c.req.query('code');
    const expected = getCookie(c, 'pb_oauth_state');
    const verifier = getCookie(c, 'pb_oauth_verifier');
    const returnTo = safeReturnTo(getCookie(c, 'pb_return_to'));
    for (const name of ['pb_oauth_state', 'pb_oauth_verifier', 'pb_return_to'])
      deleteCookie(c, name, { path: '/' });
    if (!state || !code || !expected || !verifier || state !== expected) {
      return c.redirect('/login?error=state');
    }
    try {
      const tokens = await google.validateAuthorizationCode(code, verifier);
      const claims = decodeIdToken(tokens.idToken()) as {
        sub: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      if (!claims.email || claims.email_verified !== true) return c.redirect('/login?error=unverified');
      const user = users.upsert({
        email: claims.email,
        name: claims.name ?? claims.email.split('@')[0]!,
        avatarUrl: claims.picture ?? null,
        googleSub: claims.sub,
      });
      startSession(c, user.id);
      return c.redirect(returnTo);
    } catch {
      return c.redirect('/login?error=google');
    }
  });

  app.post('/dev', async (c) => {
    if (!config.devLogin) throw new HttpError(404, 'Not found');
    const body = z
      .object({ email: z.email(), name: z.string().max(80).optional(), returnTo: z.string().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw badRequest('A valid email is required');
    const user = users.upsert({
      email: body.data.email,
      name: body.data.name || body.data.email.split('@')[0]!,
    });
    startSession(c, user.id);
    return c.json({ ok: true, returnTo: safeReturnTo(body.data.returnTo) });
  });

  app.post('/logout', (c) => {
    users.deleteSession(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  return app;
}
