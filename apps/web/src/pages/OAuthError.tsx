import { AlertTriangle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { PageContainer } from '../components/AppShell.tsx';
import { Button, EmptyState } from '../components/ui.tsx';
import { useDocumentTitle } from '../lib/hooks.ts';

export default function OAuthError() {
  useDocumentTitle('Connection failed');
  const [params] = useSearchParams();
  const reason = params.get('reason');
  return (
    <PageContainer className="max-w-xl py-20">
      <EmptyState
        icon={<AlertTriangle className="size-6" />}
        title="Could not connect the app"
        action={
          <Link to="/settings">
            <Button>Connection help</Button>
          </Link>
        }
      >
        <p>The AI client sent an authorization request Patchbay cannot accept, so nothing was shared.</p>
        {reason ? (
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12px] text-ink">
            {reason.slice(0, 300)}
          </p>
        ) : null}
      </EmptyState>
    </PageContainer>
  );
}
