import type { ReactNode } from 'react';
import { PageContainer } from '../components/AppShell.tsx';
import { useAuthConfig, useDocumentTitle } from '../lib/hooks.ts';
import { retentionSentences } from '../lib/retention.ts';
import { PageHeader } from './_shared.tsx';

const ISSUES = 'https://github.com/carnaby/patchbay/issues';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

/** Static text, except the numbers that depend on how the operator configured this instance. */
export default function Privacy() {
  useDocumentTitle('Privacy');
  const { data: config } = useAuthConfig();
  const retention = config
    ? retentionSentences(config.pruneAnonymousAfterDays, config.pruneBlankAnonymousAfterHours)
    : [];

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="Privacy"
        subtitle="What this Patchbay instance stores, for how long, and how to have it removed. Nothing is sold or shared with advertisers."
      />

      <Section title="What is stored">
        <List>
          <li>Your dashboards, every saved version of them, and the files you upload into them.</li>
          <li>
            If you sign in with Google: your account email and name, your sessions, the personal access tokens
            and OAuth grants you create (stored hashed, so nobody can read them back), and the secrets you
            save for data sources (stored encrypted).
          </li>
          <li>
            Without an account: the dashboard and its files only. Your browser keeps the edit key of each
            anonymous dashboard in its local storage, so you can edit it again; the server does not know who
            you are.
          </li>
        </List>
        <p>
          Data that dashboards show comes from the sources they name (public APIs, files, URLs). Patchbay
          fetches it on the server and does not keep a copy beyond a short cache.
        </p>
      </Section>

      <Section title="Anonymous dashboards">
        <p>
          A dashboard created without signing in is public: anyone with its link can see it. Do not put
          anything in it you would not want a stranger with the link to read.
        </p>
        {retention.length ? (
          <List>
            {retention.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </List>
        ) : null}
      </Section>

      <Section title="Analytics">
        {config?.analytics ? (
          <p>
            The operator of this instance counts page views with Umami. It sets no cookies. Query strings are
            removed, and dashboard addresses and titles are replaced by a generic "Dashboard" in your browser
            before anything is sent, so which dashboards you open never leaves it.
          </p>
        ) : (
          <p>This instance does not run any analytics and loads no third-party scripts.</p>
        )}
      </Section>

      <Section title="Deleting your data">
        <List>
          <li>Delete a dashboard in the app (its menu); its versions and uploaded files go with it.</li>
          <li>Revoke tokens, connected apps and secrets in Settings.</li>
          <li>
            There is no button to delete an account yet. To have your account and everything it owns removed,
            ask the operator of this instance. For the public instance at patchbay.me.uk, open an{' '}
            <a
              className="text-ink underline underline-offset-2 hover:text-ink-2"
              href={ISSUES}
              target="_blank"
              rel="noreferrer"
            >
              issue on GitHub
            </a>{' '}
            and name the email you signed in with.
          </li>
        </List>
      </Section>

      <Section title="Contact">
        <p>
          Questions about this page or your data: ask the operator of this instance, or open an{' '}
          <a
            className="text-ink underline underline-offset-2 hover:text-ink-2"
            href={ISSUES}
            target="_blank"
            rel="noreferrer"
          >
            issue on GitHub
          </a>
          . Patchbay is open source, so you can read exactly what it does.
        </p>
      </Section>
    </PageContainer>
  );
}
