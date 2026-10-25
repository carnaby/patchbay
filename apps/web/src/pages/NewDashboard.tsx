import type { DashboardEnvelope } from '@patchbay/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bitcoin, CloudSun, FileQuestion, Info, Plus, Radio, ShoppingCart, Waves } from 'lucide-react';
import { type ComponentType, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageContainer } from '../components/AppShell.tsx';
import { Badge, Button, Card, cx, Field, Input, Spinner } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { saveEditKey } from '../lib/edit-keys.ts';
import { useDocumentTitle, useMe } from '../lib/hooks.ts';
import { PageHeader } from './_shared.tsx';

interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  blank: Plus,
  'live-signal': Radio,
  weather: CloudSun,
  crypto: Bitcoin,
  earthquakes: Waves,
  sales: ShoppingCart,
};

export default function NewDashboard() {
  useDocumentTitle('New dashboard');
  const navigate = useNavigate();
  const { data: user } = useMe();
  const [selected, setSelected] = useState('blank');
  const [title, setTitle] = useState('');
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateInfo[]>('/api/templates'),
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ envelope: DashboardEnvelope; editKey?: string }>('/api/dashboards', {
        body: { template: selected, ...(title.trim() ? { title: title.trim() } : {}) },
      }),
    onSuccess: ({ envelope, editKey }) => {
      if (editKey) saveEditKey(envelope.meta.id, editKey, envelope.doc.title);
      navigate(`/d/${envelope.meta.id}?edit=1`);
    },
  });

  return (
    <PageContainer className="max-w-5xl">
      <PageHeader
        title="New dashboard"
        subtitle="Start from a template or a blank canvas. You can change everything later, by hand or through your AI agent."
      />

      {templates.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Templates">
          {(templates.data ?? []).map((t) => {
            const Icon = ICONS[t.id] ?? FileQuestion;
            const active = t.id === selected;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={active}
                onClick={() => setSelected(t.id)}
                onDoubleClick={() => create.mutate()}
                className={cx(
                  'flex flex-col items-start gap-3 rounded-xl border bg-surface p-5 text-left transition',
                  active ? 'border-ink ring-1 ring-ink' : 'border-line hover:border-line-strong',
                )}
              >
                <span
                  className={cx(
                    'flex size-9 items-center justify-center rounded-lg',
                    active ? 'bg-ink text-page' : 'bg-surface-2 text-ink',
                  )}
                >
                  <Icon className="size-4.5" />
                </span>
                <div>
                  <div className="font-semibold">{t.name}</div>
                  <p className="mt-1 text-sm text-ink-2">{t.description}</p>
                </div>
                {t.tags.length ? (
                  <div className="mt-auto flex flex-wrap gap-1">
                    {t.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </div>
                ) : null}
              </button>
            );
          })}
        </section>
      )}

      <Card className="mt-8 flex flex-col gap-4 p-5 sm:flex-row sm:items-end">
        <Field label="Title (optional)" className="flex-1">
          {(id) => (
            <Input
              id={id}
              value={title}
              maxLength={120}
              placeholder={
                selected === 'blank'
                  ? 'Untitled dashboard'
                  : (templates.data?.find((t) => t.id === selected)?.name ?? 'Untitled dashboard')
              }
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create.mutate()}
            />
          )}
        </Field>
        <Button
          variant="accent"
          size="md"
          loading={create.isPending}
          onClick={() => create.mutate()}
          className="sm:w-48"
        >
          Create dashboard
        </Button>
      </Card>

      {user === null ? (
        <p className="mt-4 flex gap-2 text-sm text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-muted" />
          <span>
            You are not signed in, so this dashboard will be <strong className="text-ink">public</strong>{' '}
            (anyone with the link can view it) and editable only from this browser.{' '}
            <Link to="/login?returnTo=/new" className="text-ink underline">
              Sign in
            </Link>{' '}
            to make private dashboards and connect an AI agent. You can claim this one later.
          </span>
        </p>
      ) : null}
    </PageContainer>
  );
}
