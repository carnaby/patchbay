import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bot, CornerDownRight, Eye, Globe, KeyRound, PencilLine } from 'lucide-react';
import type { ComponentType } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { Button, Card, EmptyState, Spinner } from '../components/ui.tsx';
import { api, errorMessage } from '../lib/api.ts';
import { useDocumentTitle, useMe, useSecretsStatus } from '../lib/hooks.ts';

interface ConsentRequest {
  id: string;
  clientName: string;
  clientKind: 'dcr' | 'cimd';
  clientId: string;
  /** Host of the metadata document URL for CIMD clients; null for self-registered ones. */
  clientHost: string | null;
  redirectHost: string;
  redirectKind: 'web' | 'loopback' | 'app';
  scopes: string[];
}

const SCOPES: Record<string, { icon: ComponentType<{ className?: string }>; title: string; body: string }> = {
  'dashboards:read': {
    icon: Eye,
    title: 'See your dashboards and data',
    body: 'List and open your dashboards, read their datasets and render previews.',
  },
  'dashboards:write': {
    icon: PencilLine,
    title: 'Create and change dashboards',
    body: 'Add data sources and widgets, upload files and change visibility. Every change is a new version you can undo.',
  },
};

export default function OAuthConsent() {
  useDocumentTitle('Authorize access');
  const [params] = useSearchParams();
  const location = useLocation();
  const requestId = params.get('request') ?? '';
  const { data: user, isLoading: userLoading } = useMe();
  const { data: secrets } = useSecretsStatus();
  const request = useQuery({
    queryKey: ['oauth-request', requestId],
    queryFn: () => api<ConsentRequest>(`/api/oauth/requests/${encodeURIComponent(requestId)}`),
    enabled: Boolean(user && requestId),
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api<{ redirect: string }>(`/api/oauth/requests/${encodeURIComponent(requestId)}`, {
        body: { approve },
      }),
    onSuccess: (r) => {
      window.location.href = r.redirect;
    },
  });

  if (userLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!user)
    return (
      <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />
    );

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {request.isLoading ? (
          <div className="flex justify-center">
            <Spinner />
          </div>
        ) : request.error || !request.data ? (
          <EmptyState icon={<AlertTriangle className="size-6" />} title="This request is no longer valid">
            {request.error ? errorMessage(request.error) : 'Missing authorization request.'} Start the
            connection again from your AI client.
          </EmptyState>
        ) : (
          <Card className="p-6">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex size-11 items-center justify-center rounded-xl bg-surface-2">
                <Bot className="size-5" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold">“{request.data.clientName}”</h1>
                <p className="text-sm text-ink-2">
                  An app calling itself this wants to access your Patchbay account
                </p>
              </div>
            </div>

            {/* Any app can call itself "Claude": the name is self-declared, so the addresses are what to check. */}
            <dl className="mb-4 space-y-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm">
              <div>
                <dt className="text-xs text-muted">Identity</dt>
                <dd className="flex items-center gap-1.5">
                  <Globe className="size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
                  {request.data.clientHost ? (
                    <span>
                      Published by{' '}
                      <span className="font-mono text-[13px] font-medium break-all">
                        {request.data.clientHost}
                      </span>
                    </span>
                  ) : (
                    <span>Registered itself: name and identity are not verified</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">After approving, you are sent to</dt>
                <dd className="flex items-center gap-1.5">
                  <CornerDownRight className="size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
                  <span className="font-mono text-[13px] font-medium break-all">
                    {request.data.redirectHost}
                  </span>
                  {request.data.redirectKind !== 'web' ? (
                    <span className="text-xs text-ink-2">
                      (
                      {request.data.redirectKind === 'loopback'
                        ? 'an app on this computer'
                        : 'an installed app'}
                      )
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>
            {request.data.clientKind === 'dcr' ? (
              <p className="mb-4 flex gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ink" />
                <span>
                  Only continue if you just started connecting this app yourself and the address above is the
                  one you expect.
                </span>
              </p>
            ) : (
              <p className="mb-4 text-xs text-ink-2">
                The name is chosen by the app. Only continue if you started connecting it and you recognise
                the addresses above.
              </p>
            )}

            <ul className="space-y-3 border-y border-line py-4">
              {request.data.scopes.map((s) => {
                const info = SCOPES[s];
                const Icon = info?.icon ?? Eye;
                return (
                  <li key={s} className="flex gap-3">
                    <Icon className="mt-0.5 size-4 shrink-0 text-ink-2" />
                    <div>
                      <div className="text-sm font-medium">{info?.title ?? s}</div>
                      {info ? <div className="text-xs text-ink-2">{info.body}</div> : null}
                      {s === 'dashboards:write' && secrets?.canUseSecrets ? (
                        <div className="mt-1 flex items-center gap-1 text-xs text-ink-2">
                          <KeyRound className="size-3 shrink-0" aria-hidden="true" />
                          Use secrets you saved in your own dashboards (never read them).
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>

            <p className="mt-4 text-xs text-muted">
              Signed in as <span className="text-ink-2">{user.email}</span>. You can revoke access any time in
              AI connections.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-2">
              <Button size="lg" onClick={() => decide.mutate(false)} disabled={decide.isPending}>
                Deny
              </Button>
              <Button
                size="lg"
                variant="primary"
                loading={decide.isPending && decide.variables === true}
                onClick={() => decide.mutate(true)}
              >
                Approve
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
