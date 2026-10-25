import { Unplug } from 'lucide-react';
import { Link } from 'react-router';
import { PageContainer } from '../components/AppShell.tsx';
import { Button, EmptyState } from '../components/ui.tsx';
import { useDocumentTitle } from '../lib/hooks.ts';

export default function NotFound() {
  useDocumentTitle('Not found');
  return (
    <PageContainer className="max-w-xl py-20">
      <EmptyState
        icon={<Unplug className="size-7" />}
        title="Nothing is patched in here"
        action={
          <Link to="/">
            <Button variant="primary">Back to the start</Button>
          </Link>
        }
      >
        The page you are looking for does not exist, or the dashboard was deleted.
      </EmptyState>
    </PageContainer>
  );
}
