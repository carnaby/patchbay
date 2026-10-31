import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { Logo } from '../components/AppShell.tsx';
import { Button, Card, Field, Input, Spinner } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useAuthConfig, useDocumentTitle, useMe } from '../lib/hooks.ts';

const ERRORS: Record<string, string> = {
  state: 'The sign-in session expired. Please try again.',
  unverified: 'Your Google account email is not verified.',
  google: 'Google sign-in failed. Please try again.',
};

/** Mirrors the server's check (routes/auth.ts), which is the one that counts: it guards the actual redirect. */
function safeReturnTo(raw: string | null): string {
  if (!raw?.startsWith('/') || /[\s\\\p{Cc}\p{Cf}]/u.test(raw)) return '/me';
  try {
    const url = new URL(raw, window.location.origin);
    const path = `${url.pathname}${url.search}${url.hash}`;
    return url.origin === window.location.origin && !path.startsWith('//') ? path : '/me';
  } catch {
    return '/me';
  }
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9c-.3 1.4-1 2.5-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9C3.9 20.6 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.8 14.1c-.2-.7-.4-1.4-.4-2.1s.1-1.4.4-2.1V7H2.1C1.4 8.5 1 10.2 1 12s.4 3.5 1.1 5l3.7-2.9z"
      />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2C17.5 2.1 15 1 12 1 7.7 1 3.9 3.4 2.1 7l3.7 2.9c.9-2.6 3.3-4.5 6.2-4.5z"
      />
    </svg>
  );
}

export default function Login() {
  useDocumentTitle('Sign in');
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const error = params.get('error');
  const { data: user } = useMe();
  const config = useAuthConfig();
  const [email, setEmail] = useState('');
  const dev = useMutation({
    mutationFn: () => api<{ returnTo: string }>('/auth/dev', { body: { email, returnTo } }),
    onSuccess: (r) => {
      window.location.href = r.returnTo;
    },
  });

  if (user) return <Navigate to={returnTo} replace />;

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <Card className="p-6">
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1.5 text-sm text-ink-2">
            You only need an account for private dashboards and for connecting an AI agent over MCP.
            Everything else works without one.
          </p>

          {error ? (
            <div className="mt-4 flex gap-2 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {ERRORS[error] ?? 'Sign-in failed. Please try again.'}
            </div>
          ) : null}

          <div className="mt-6 space-y-3">
            {config.isLoading ? (
              <div className="flex justify-center py-2">
                <Spinner />
              </div>
            ) : config.data?.google ? (
              <a href={`/auth/google?returnTo=${encodeURIComponent(returnTo)}`} className="block">
                <Button size="lg" className="w-full" icon={<GoogleIcon />}>
                  Continue with Google
                </Button>
              </a>
            ) : !config.data?.devLogin ? (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">
                Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID and
                GOOGLE_CLIENT_SECRET.
              </p>
            ) : null}

            {config.data?.devLogin ? (
              <form
                className="space-y-3 rounded-xl border border-dashed border-line-strong p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  dev.mutate();
                }}
              >
                <div className="flex items-center gap-2 text-xs font-medium text-muted">
                  <Wrench className="size-3.5" /> Development login (no password, never enable in production)
                </div>
                <Field label="Email">
                  {(id) => (
                    <Input
                      id={id}
                      type="email"
                      required
                      value={email}
                      placeholder="you@example.com"
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  )}
                </Field>
                <Button type="submit" variant="primary" className="w-full" loading={dev.isPending}>
                  Sign in as this email
                </Button>
              </form>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
