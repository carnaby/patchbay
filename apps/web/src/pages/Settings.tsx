import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, KeyRound, LockKeyhole, Plug, Terminal, Trash2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { PageContainer } from '../components/AppShell.tsx';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Segmented,
  Select,
  Spinner,
  Toggle,
  toast,
} from '../components/ui.tsx';
import { ACCOUNT_DELETED_URL, emailMatches, erasureItems } from '../lib/account.ts';
import { api, errorMessage } from '../lib/api.ts';
import { relativeTime, useDocumentTitle, useMe, useSecrets } from '../lib/hooks.ts';
import { secretsSectionMode } from '../lib/secrets.ts';
import { CopyField, PageHeader } from './_shared.tsx';
import { SecretsManager } from './SettingsSecrets.tsx';

interface PatInfo {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

interface GrantInfo {
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

function Section({
  id,
  icon,
  title,
  subtitle,
  children,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mb-12 scroll-mt-20">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <span className="text-muted">{icon}</span>
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-1 mb-4 max-w-2xl text-sm text-ink-2">{subtitle}</p>
      ) : (
        <div className="mb-4" />
      )}
      {children}
    </section>
  );
}

type Client = 'claude' | 'claude-code' | 'other';

function McpSetup() {
  const url = `${window.location.origin}/mcp`;
  const [client, setClient] = useState<Client>('claude');
  return (
    <Card className="p-5">
      <div className="mb-4">
        <div className="mb-1.5 text-xs font-medium text-muted">MCP server URL</div>
        <CopyField value={url} label="Copy MCP URL" />
      </div>
      <Segmented<Client>
        value={client}
        onChange={setClient}
        options={[
          { value: 'claude', label: 'Claude app' },
          { value: 'claude-code', label: 'Claude Code' },
          { value: 'other', label: 'Other clients' },
        ]}
      />
      <div className="mt-4 text-sm text-ink-2">
        {client === 'claude' ? (
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              Open <strong className="text-ink">Settings → Connectors</strong> in Claude (web or desktop).
            </li>
            <li>
              Choose <strong className="text-ink">Add custom connector</strong> and paste the URL above.
            </li>
            <li>Claude opens a Patchbay window: sign in with Google and approve access.</li>
            <li>Ask: “Build me a live dashboard of the weather in Vienna.”</li>
          </ol>
        ) : client === 'claude-code' ? (
          <div className="space-y-3">
            <p>
              Add the server, then run <code className="font-mono text-ink">/mcp</code> inside Claude Code to
              sign in:
            </p>
            <CodeBlock>{`claude mcp add --transport http patchbay ${url}`}</CodeBlock>
          </div>
        ) : (
          <div className="space-y-3">
            <p>
              Any client that supports remote MCP servers over Streamable HTTP with OAuth will discover the
              authorization server automatically. Clients without OAuth support can use a personal access
              token below:
            </p>
            <CodeBlock>{`URL:     ${url}\nHeader:  Authorization: Bearer <your token>`}</CodeBlock>
          </div>
        )}
      </div>
    </Card>
  );
}

const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '', label: 'Never' },
];

function TokenSection({ tokens }: { tokens: PatInfo[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const [expiry, setExpiry] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PatInfo | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ token: string; info: PatInfo }>('/api/tokens', {
        body: {
          name: name.trim() || 'Personal token',
          scopes: write ? ['dashboards:read', 'dashboards:write'] : ['dashboards:read'],
          ...(expiry ? { expiresInDays: Number(expiry) } : {}),
        },
      }),
    onSuccess: (r) => {
      setCreated(r.token);
      setName('');
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: ['tokens'] });
      toast('Token revoked');
    },
  });
  const url = `${window.location.origin}/mcp`;

  return (
    <>
      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={80}
                placeholder="e.g. Local scripts"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Expires">
            {(id) => (
              <Select id={id} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY.map((o) => (
                  <option key={o.label} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="sm:w-80">
            <Toggle checked={write} onChange={setWrite} label="Allow creating and editing dashboards" />
          </div>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            Create token
          </Button>
        </div>
      </Card>

      {tokens.length ? (
        <Card className="mt-4 divide-y divide-line">
          {tokens.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
              <span className="flex gap-1">
                {t.scopes.map((s) => (
                  <Badge key={s} tone={s.endsWith('write') ? 'accent' : 'neutral'}>
                    {s.split(':')[1]}
                  </Badge>
                ))}
              </span>
              <span className="text-xs text-muted">
                {t.lastUsedAt ? `used ${relativeTime(t.lastUsedAt)}` : 'never used'}
              </span>
              <span className="text-xs text-muted">
                {t.expiresAt ? `expires ${relativeTime(t.expiresAt)}` : 'no expiry'}
              </span>
              <IconButton
                label={`Revoke ${t.name}`}
                onClick={() => setRevoking(t)}
                className="hover:text-bad"
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </Card>
      ) : null}

      <Modal
        open={created !== null}
        title="Copy your token now"
        onClose={() => setCreated(null)}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            Done
          </Button>
        }
      >
        <p className="mb-3">This is the only time it is shown. Treat it like a password.</p>
        {created ? <CopyField value={created} label="Copy token" /> : null}
        <p className="mt-4 mb-2 text-xs text-muted">Claude Code:</p>
        <CodeBlock className="text-[11.5px]">{`claude mcp add --transport http patchbay ${url} \\\n  --header "Authorization: Bearer ${created ?? '<token>'}"`}</CodeBlock>
        <p className="mt-3 mb-2 text-xs text-muted">REST API:</p>
        <CodeBlock className="text-[11.5px]">{`curl ${window.location.origin}/api/dashboards \\\n  --header "Authorization: Bearer ${created ?? '<token>'}"`}</CodeBlock>
      </Modal>

      <Modal
        open={revoking !== null}
        title="Revoke token?"
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() => revoking && revoke.mutate(revoking.id)}
            >
              Revoke
            </Button>
          </>
        }
      >
        Anything using “{revoking?.name}” stops working immediately.
      </Modal>
    </>
  );
}

function GrantsSection({ grants }: { grants: GrantInfo[] }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/grants/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tokens'] });
      toast('Access revoked');
    },
  });
  if (grants.length === 0) {
    return (
      <EmptyState icon={<Plug className="size-6" />} title="No connected apps">
        When you connect an MCP client with OAuth, it appears here and you can revoke it at any time.
      </EmptyState>
    );
  }
  return (
    <Card className="divide-y divide-line">
      {grants.map((g) => (
        <div key={g.grantId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
          <Bot className="size-4 text-muted" />
          <span className="min-w-0 flex-1 truncate font-medium" title={g.clientId}>
            {g.clientName}
          </span>
          <span className="flex gap-1">
            {g.scopes.map((s) => (
              <Badge key={s} tone={s.endsWith('write') ? 'accent' : 'neutral'}>
                {s.split(':')[1]}
              </Badge>
            ))}
          </span>
          <span className="text-xs text-muted">connected {relativeTime(g.createdAt)}</span>
          <Button
            size="sm"
            variant="danger"
            loading={revoke.isPending && revoke.variables === g.grantId}
            onClick={() => revoke.mutate(g.grantId)}
          >
            Revoke
          </Button>
        </div>
      ))}
    </Card>
  );
}

function DeleteAccount({
  email,
  isAdmin,
  tokens,
  grants,
  secrets,
}: {
  email: string;
  isAdmin: boolean;
  tokens: number;
  grants: number;
  secrets: number;
}) {
  const qc = useQueryClient();
  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api<unknown[]>('/api/dashboards'),
  });
  const [typed, setTyped] = useState('');
  const erase = useMutation({
    mutationFn: () => api('/api/me', { method: 'DELETE', body: { confirm: typed } }),
    onSuccess: () => {
      // The session cookie is already gone; a full load drops every cached query and any open live stream.
      qc.clear();
      window.location.assign(ACCOUNT_DELETED_URL);
    },
  });
  const items = erasureItems({
    dashboards: dashboards.data?.length ?? 0,
    secrets,
    tokens,
    connectedApps: grants,
  });
  const ready = emailMatches(typed, email);
  return (
    <Card className="border-bad/40 p-5">
      <p className="text-sm text-ink-2">
        This permanently deletes your account and everything it owns:{' '}
        <strong className="text-ink">
          {items.length ? items.join(', ') : 'no dashboards, secrets or tokens yet'}
        </strong>
        . Dashboards go with their versions and uploaded files. Copies other people made of your public
        dashboards are theirs and stay. Anonymous dashboards are not linked to your account and are not
        affected. This cannot be undone.
      </p>
      {isAdmin ? (
        <p className="mt-2 text-sm text-ink-2">
          Your email is listed as an administrator of this instance. Signing in again creates a fresh, empty
          account.
        </p>
      ) : null}
      <form
        className="mt-4 grid gap-3 sm:max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) erase.mutate();
        }}
      >
        <Field label={`Type ${email} to confirm`}>
          {(id) => (
            <Input
              id={id}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder={email}
              onChange={(e) => setTyped(e.target.value)}
            />
          )}
        </Field>
        {erase.error ? (
          <p role="alert" className="text-sm text-bad">
            {errorMessage(erase.error)}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="danger" disabled={!ready} loading={erase.isPending}>
            Delete my account
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function Settings() {
  useDocumentTitle('AI connections');
  const { data: user, isLoading } = useMe();
  const data = useQuery({
    queryKey: ['tokens'],
    queryFn: () => api<{ tokens: PatInfo[]; grants: GrantInfo[] }>('/api/tokens'),
    enabled: Boolean(user),
  });
  const secrets = useSecrets(Boolean(user));
  const location = useLocation();
  // Agents send users to /settings#secrets; the section only exists once the list has loaded.
  useEffect(() => {
    if (location.hash === '#secrets' && secrets.data)
      document.getElementById('secrets')?.scrollIntoView({ block: 'start' });
  }, [location.hash, secrets.data]);
  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!user)
    return <Navigate to={`/login?returnTo=${encodeURIComponent(`/settings${location.hash}`)}`} replace />;
  const secretsMode = secrets.data ? secretsSectionMode(secrets.data) : 'hidden';
  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="AI connections & tokens"
        subtitle="Let an AI agent build and edit your dashboards through the Model Context Protocol, and store the keys your data sources need."
      />
      <Section icon={<Terminal className="size-5" />} title="Connect an MCP client">
        <McpSetup />
      </Section>
      <Section
        icon={<Plug className="size-5" />}
        title="Connected apps"
        subtitle="MCP clients you approved with OAuth."
      >
        {data.isLoading ? <Spinner /> : <GrantsSection grants={data.data?.grants ?? []} />}
      </Section>
      <Section
        icon={<KeyRound className="size-5" />}
        title="Personal access tokens"
        subtitle="For development, scripts and MCP clients without OAuth. Prefer OAuth where you can: it is easier to revoke per app."
      >
        <TokenSection tokens={data.data?.tokens ?? []} />
      </Section>
      {secrets.data && secretsMode !== 'hidden' ? (
        <Section
          id="secrets"
          icon={<LockKeyhole className="size-5" />}
          title="Secrets"
          subtitle="API keys and tokens for JSON URL data sources. Each one is only sent to the address you allow, only from dashboards you own, and nobody can read it back in Patchbay, AI agents included."
        >
          <SecretsManager list={secrets.data} />
        </Section>
      ) : null}
      <Section
        id="delete-account"
        icon={<TriangleAlert className="size-5 text-bad" />}
        title="Delete account"
        subtitle="Remove your account and all your data from this instance."
      >
        <DeleteAccount
          email={user.email}
          isAdmin={user.isAdmin}
          tokens={data.data?.tokens.length ?? 0}
          grants={data.data?.grants.length ?? 0}
          secrets={secrets.data?.secrets.length ?? 0}
        />
      </Section>
      <p className="mt-10 text-center text-xs text-muted">
        <Link to="/privacy" className="underline hover:text-ink">
          Privacy: what is stored and how to delete it
        </Link>
      </p>
    </PageContainer>
  );
}
