import { type DatasetResult, type Widget, WidgetSchema } from '@patchbay/core';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Bot,
  Camera,
  Database,
  FileSpreadsheet,
  History,
  LayoutGrid,
  Lock,
  type LucideIcon,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { Link } from 'react-router';
import { Logo } from '../components/AppShell.tsx';
import { Button, cx } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useDocumentTitle, useMe } from '../lib/hooks.ts';
import { WidgetBody } from '../widgets/WidgetBody.tsx';
import { CopyField } from './_shared.tsx';

type Showcase = Record<'signal' | 'revenue' | 'products', DatasetResult>;

// Parsed once so every widget gets its schema defaults, exactly as on a real dashboard.
const W = {
  traffic: WidgetSchema.parse({
    id: 'traffic',
    type: 'chart',
    title: 'Requests per second',
    datasetId: 'signal',
    config: {
      kind: 'line',
      x: 'time',
      y: ['value'],
      series: 'series',
      smooth: true,
      format: { style: 'number', decimals: 0 },
    },
  }),
  now: WidgetSchema.parse({
    id: 'now',
    type: 'kpi',
    title: 'Alpha, live',
    datasetId: 'signal',
    config: {
      field: 'value',
      compare: 'previous',
      sparkline: true,
      format: { style: 'number', decimals: 0, suffix: ' rps' },
    },
  }),
  revenue: WidgetSchema.parse({
    id: 'revenue',
    type: 'chart',
    title: 'Weekly revenue by region',
    datasetId: 'revenue',
    config: {
      kind: 'area',
      x: 'date',
      y: ['revenue'],
      series: 'region',
      stacked: true,
      format: { style: 'compact' },
    },
  }),
  products: WidgetSchema.parse({
    id: 'products',
    type: 'chart',
    title: 'Revenue share',
    datasetId: 'products',
    config: { kind: 'donut', x: 'product', y: ['revenue'] },
  }),
} satisfies Record<string, Widget>;

function useShowcase() {
  const { data, isLoading } = useQuery({
    queryKey: ['showcase'],
    queryFn: () => api<Showcase>('/api/showcase'),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  });
  return { signal: data?.signal, revenue: data?.revenue, products: data?.products, loading: isLoading };
}

function DemoCard({
  title,
  live,
  className,
  children,
}: {
  title: string;
  live?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx('flex min-h-0 flex-col rounded-xl border border-line bg-surface p-4', className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="truncate text-[13px] font-semibold">{title}</h3>
        {live ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex size-2 rounded-full bg-good" />
            </span>
            live
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function LiveDemo() {
  const { signal, revenue, products, loading } = useShowcase();
  const alpha = useMemo<DatasetResult | undefined>(
    () =>
      signal
        ? {
            ...signal,
            table: { ...signal.table, rows: signal.table.rows.filter((r) => r.series === 'alpha') },
          }
        : undefined,
    [signal],
  );
  return (
    <div className="rounded-2xl border border-line bg-page p-2 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.35)] sm:p-3">
      <div className="mb-2 flex items-center gap-1.5 px-2 pt-1">
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="ml-3 truncate font-mono text-[11px] text-muted">patchbay / showcase</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-12">
        <DemoCard title="Alpha, live" live className="h-52 md:col-span-4">
          <WidgetBody widget={W.now} result={alpha} loading />
        </DemoCard>
        <DemoCard title="Requests per second" live className="h-52 md:col-span-8">
          <WidgetBody widget={W.traffic} result={signal} loading />
        </DemoCard>
        <DemoCard title="Weekly revenue by region" className="h-64 md:col-span-7">
          <WidgetBody widget={W.revenue} result={revenue} loading={loading} />
        </DemoCard>
        <DemoCard title="Revenue share" className="h-64 md:col-span-5">
          <WidgetBody widget={W.products} result={products} loading={loading} />
        </DemoCard>
      </div>
    </div>
  );
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** The brand motif: two jacks joined by a moving patch cable. */
function Cable({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 40" className={className} aria-hidden="true">
      <circle cx="8" cy="20" r="5" fill="var(--pb-accent)" />
      <circle cx="112" cy="20" r="5" fill="var(--pb-data)" />
      <path
        d="M8 20 C 40 -4, 80 44, 112 20"
        className="pb-cable"
        stroke="var(--pb-accent)"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Hero() {
  // Same cached query as the header's account menu, so this adds no request.
  const { data: user } = useMe();
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div
        className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(var(--pb-line)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-6xl px-4 pt-14 pb-12 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-2">
            <Cable className="h-4 w-12" />
            Free &amp; open source · MCP-native
          </div>
          <h1 className="text-[clamp(2.2rem,6vw,4rem)] leading-[1.05] font-semibold tracking-tight text-balance">
            Patch any data into a <span className="text-accent">live dashboard</span>.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-[clamp(1rem,2vw,1.2rem)] text-pretty text-ink-2">
            Public APIs, your own CSVs, updates in real time. Wire it up by hand, or tell your AI agent what
            you want and watch it build the dashboard over MCP.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:flex-wrap">
            <Link to="/new" className="w-full sm:w-auto">
              <Button variant="accent" size="lg" className="w-full" icon={<Zap className="size-4" />}>
                {user ? 'Build a dashboard' : 'Build a dashboard, no sign-up'}
              </Button>
            </Link>
            {user ? (
              <Link to="/me" className="w-full sm:w-auto">
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full"
                  icon={<LayoutGrid className="size-4" />}
                >
                  My dashboards
                </Button>
              </Link>
            ) : null}
            <a href="#mcp" className="w-full sm:w-auto">
              <Button variant="secondary" size="lg" className="w-full" icon={<Bot className="size-4" />}>
                Connect your AI
              </Button>
            </a>
          </div>
        </div>
        <div className="mx-auto mt-12 max-w-5xl">
          <LiveDemo />
        </div>
      </div>
    </section>
  );
}

function SectionTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      <div className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{eyebrow}</div>
      <h2 className="text-[clamp(1.6rem,4vw,2.3rem)] leading-tight font-semibold tracking-tight text-balance">
        {title}
      </h2>
      {children ? <p className="mt-3 text-ink-2 text-pretty">{children}</p> : null}
    </div>
  );
}

const STEPS: { icon: LucideIcon; title: string; body: string; example: string }[] = [
  {
    icon: Database,
    title: 'Plug in a source',
    body: 'Pick one of 16 free public APIs, upload a CSV or JSON file, or point at any public HTTPS endpoint.',
    example: 'weather.forecast · city: "Bratislava"',
  },
  {
    icon: SlidersHorizontal,
    title: 'Shape it with rules',
    body: 'Filter, derive, bucket by time, aggregate, run rolling windows. Declarative steps, evaluated safely on the server.',
    example: 'timeBucket(day) → aggregate(max temp)',
  },
  {
    icon: Radio,
    title: 'Watch it live',
    body: 'Datasets refresh on their own interval and stream to every open browser. Only changed data is sent.',
    example: 'refresh every 60 s · pushed via SSE',
  },
];

function HowItWorks() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20">
      <SectionTitle eyebrow="How it works" title="Source in, rules in the middle, live charts out." />
      {/* grid-cols-1 makes the track minmax(0, 1fr): an implicit auto track grows to the cards' min-content
          width and pushed the page sideways on narrow phones. */}
      <div className="relative grid grid-cols-1 gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title} className="relative rounded-2xl border border-line bg-surface p-6">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-surface-2 text-ink">
                <s.icon className="size-4.5" />
              </span>
              <span className="font-mono text-xs text-muted">0{i + 1}</span>
            </div>
            <h3 className="text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 text-sm text-ink-2">{s.body}</p>
            <div className="mt-4 rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12px] break-words text-ink-2">
              {s.example}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

type Line =
  | { kind: 'user'; text: string }
  | { kind: 'tool'; name: string; args: string; result: string }
  | { kind: 'ai'; text: string };

const TRANSCRIPT: Line[] = [
  {
    kind: 'user',
    text: 'Make me a dashboard of this week’s earthquakes. Strongest ones first, and where they happen.',
  },
  {
    kind: 'tool',
    name: 'create_dashboard',
    args: '{ title: "Earthquakes this week" }',
    result: 'dashboardId: "k3m8…", version 1',
  },
  {
    kind: 'tool',
    name: 'preview_data',
    args: '{ connector: "earthquakes", period: "week" }',
    result: '1,412 rows · time, magnitude, place, latitude, longitude…',
  },
  {
    kind: 'tool',
    name: 'apply_operations',
    args: '[addDataset, addWidget ×5]',
    result: 'version 2 · 6 changes · data checks ok',
  },
  { kind: 'tool', name: 'render_snapshot', args: '{ dashboardId: "k3m8…" }', result: '🖼 PNG 1280×860' },
  {
    kind: 'ai',
    text: 'Done. I checked the render: the region chart was crowded, so I made it horizontal. Here is the link.',
  },
];

function Transcript() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs text-muted">
        <Bot className="size-3.5" /> Your AI agent · connected to Patchbay
      </div>
      <ol className="space-y-3 p-4 text-sm">
        {TRANSCRIPT.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          <li key={i}>
            {line.kind === 'user' ? (
              <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-page">
                {line.text}
              </div>
            ) : line.kind === 'ai' ? (
              <div className="w-fit max-w-[90%] rounded-2xl rounded-bl-md bg-surface-2 px-3.5 py-2 text-ink">
                {line.text}
              </div>
            ) : (
              <div className="rounded-lg border border-line bg-page px-3 py-2 font-mono text-[12px]">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="text-accent">▸ {line.name}</span>
                  <span className="truncate text-muted">{line.args}</span>
                </div>
                <div className="mt-0.5 truncate text-ink-2">← {line.result}</div>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function McpSection() {
  const url = `${typeof window === 'undefined' ? '' : window.location.origin}/mcp`;
  return (
    <section id="mcp" className="scroll-mt-16 border-y border-line bg-surface-2/50">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-4 py-20 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">AI-first</div>
          <h2 className="text-[clamp(1.6rem,4vw,2.3rem)] leading-tight font-semibold tracking-tight text-balance">
            Your agent builds it. You watch it appear.
          </h2>
          <p className="mt-4 text-ink-2">
            Patchbay is an MCP server. Claude, or any MCP client, can explore data sources, preview your data,
            propose a processing pipeline and lay out widgets. It then{' '}
            <strong className="text-ink">looks at a rendered snapshot</strong> and fixes what looks wrong.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-ink-2">
            {[
              'Every edit is a small, validated operation, applied atomically.',
              'Every change is a version: undo the agent with one click.',
              'Changes stream into your open browser in real time.',
              'OAuth 2.1 with your Google account. Agents only get the scopes you approve.',
            ].map((t) => (
              <li key={t} className="flex gap-2.5">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-good" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
          <div className="mt-8 space-y-2">
            <div className="text-xs font-medium text-muted">MCP server URL</div>
            <CopyField value={url} label="Copy MCP URL" className="max-w-md" />
            <p className="text-xs text-muted">
              In Claude: Settings → Connectors → Add custom connector. More clients in{' '}
              <Link to="/settings" className="underline hover:text-ink">
                AI connections
              </Link>
              .
            </p>
          </div>
        </div>
        <Transcript />
      </div>
    </section>
  );
}

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Radio,
    title: 'Real time',
    body: 'Server-side refresh loops push only changed data over Server-Sent Events. Ten viewers, one upstream call.',
  },
  {
    icon: History,
    title: 'Undo, redo, versions',
    body: 'Undo every edit in the editor, and roll back to any of the last 50 saved versions, including the agent’s.',
  },
  {
    icon: Database,
    title: '16 public sources',
    body: 'Open-Meteo, CoinGecko, ECB rates, USGS earthquakes, World Bank, Wikipedia, Hacker News, GitHub, npm and more. No API keys.',
  },
  {
    icon: FileSpreadsheet,
    title: 'Your own data',
    body: 'Upload CSV or JSON. Patchbay profiles the columns and suggests how to process and chart them.',
  },
  {
    icon: Lock,
    title: 'Public or private',
    body: 'Build without an account (always public), or sign in with Google to keep dashboards private.',
  },
  {
    icon: ShieldCheck,
    title: 'Safe by design',
    body: 'Validated operations, a sandboxed expression language with no eval, SSRF-guarded fetching and rate limits.',
  },
  {
    icon: Camera,
    title: 'Agents can see',
    body: 'Dashboards render to PNG on the server, so your agent checks its own work instead of guessing.',
  },
  {
    icon: Sparkles,
    title: 'Suggestions without AI',
    body: 'A deterministic suggestion engine proposes charts for any dataset, even if you never connect an agent.',
  },
];

function Features() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20">
      <SectionTitle eyebrow="Everything included" title="All the dashboard features. No paywall.">
        Every feature is free for everyone. There is no pro plan and no hidden limit.
      </SectionTitle>
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="bg-surface p-5">
            <f.icon className="mb-3 size-5 text-ink" />
            <h3 className="font-semibold">{f.title}</h3>
            <p className="mt-1.5 text-sm text-ink-2">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function OpenSource() {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-20">
      <div className="relative overflow-hidden rounded-2xl bg-ink px-6 py-12 text-page sm:px-12">
        <Cable className="absolute -top-2 right-6 h-16 w-48 opacity-80" />
        <h2 className="max-w-xl text-[clamp(1.5rem,3.5vw,2.1rem)] leading-tight font-semibold tracking-tight">
          Open source. One process, one folder per dashboard. Host it anywhere.
        </h2>
        <p className="mt-3 max-w-xl text-sm opacity-75">
          TypeScript end to end, SQLite only for accounts, a single Docker image. Delete a dashboard’s folder
          and it is gone.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link to="/new">
            <Button
              variant="accent"
              size="lg"
              className="w-full sm:w-auto"
              icon={<ArrowRight className="size-4" />}
            >
              Start building
            </Button>
          </Link>
          <a
            href="https://github.com/carnaby/patchbay"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-page/25 px-5 font-medium text-page transition hover:bg-page/10"
          >
            <GithubMark className="size-4" />
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center">
        <Logo />
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Link to="/new" className="hover:text-ink">
            New dashboard
          </Link>
          <Link to="/settings" className="hover:text-ink">
            Connect AI
          </Link>
          <a
            href="https://github.com/carnaby/patchbay"
            className="hover:text-ink"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <span>MIT licensed</span>
        </div>
      </div>
    </footer>
  );
}

export default function Landing() {
  useDocumentTitle('Live dashboards your AI can build');
  return (
    <>
      <Hero />
      <HowItWorks />
      <McpSection />
      <Features />
      <OpenSource />
      <Footer />
    </>
  );
}
