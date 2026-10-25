import { Bot, Copy, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Card, CodeBlock, Drawer, toast } from '../components/ui.tsx';
import { useMe } from '../lib/hooks.ts';
import { useEditor } from '../state/editor.ts';

function CopyLine({ value }: { value: string }) {
  return (
    <div className="flex gap-2">
      <input
        readOnly
        value={value}
        onFocus={(e) => e.target.select()}
        className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 font-mono text-xs"
      />
      <Button
        icon={<Copy className="size-4" />}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast('Copied');
        }}
      >
        Copy
      </Button>
    </div>
  );
}

export function ConnectAiPanel({
  open,
  onClose,
  dashboardId,
}: {
  open: boolean;
  onClose: () => void;
  dashboardId: string;
}) {
  const { data: me } = useMe();
  const access = useEditor((s) => s.access);
  const mcpUrl = `${window.location.origin}/mcp`;
  const prompts = [
    `Add a 7-day weather forecast for Vienna to Patchbay dashboard ${dashboardId}, with a temperature chart and a rain chart.`,
    `Look at Patchbay dashboard ${dashboardId}, render a snapshot and tell me what could be clearer. Then fix it.`,
    `Here is my CSV. Upload it to Patchbay dashboard ${dashboardId}, suggest how to process it and build the 4 most useful widgets.`,
  ];
  return (
    <Drawer open={open} onClose={onClose} title="Connect an AI agent">
      <div className="space-y-5">
        <p className="text-sm text-ink-2">
          Patchbay speaks the Model Context Protocol. Connect Claude (or any MCP client) and ask it to build
          or change this dashboard; its edits appear here live and every one of them can be undone.
        </p>
        {!me ? (
          <Card className="space-y-2 p-4">
            <p className="text-sm">
              The agent acts as your account, so sign in first
              {access?.anonymous ? ' and claim this dashboard (Share → Claim)' : ''}.
            </p>
            <Link to={`/login?returnTo=/d/${dashboardId}`}>
              <Button variant="primary">Sign in</Button>
            </Link>
          </Card>
        ) : null}
        <section className="space-y-2">
          <h3 className="text-[13px] font-semibold text-ink-2">MCP server URL</h3>
          <CopyLine value={mcpUrl} />
        </section>
        <section className="space-y-2 text-sm text-ink-2">
          <h3 className="text-[13px] font-semibold text-ink-2">Claude (web & desktop)</h3>
          <p>
            Settings → Connectors → Add custom connector → paste the URL. You will be asked to sign in and
            approve access.
          </p>
          <h3 className="pt-2 text-[13px] font-semibold text-ink-2">Claude Code</h3>
          <CodeBlock>{`claude mcp add --transport http patchbay ${mcpUrl}`}</CodeBlock>
          <p className="text-xs text-muted">
            Clients without OAuth can use a personal access token from{' '}
            <Link to="/settings" className="underline">
              Settings
            </Link>
            .
          </p>
        </section>
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
            <Bot className="size-3.5 text-accent" /> Try asking
          </h3>
          {prompts.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(p);
                toast('Prompt copied');
              }}
              className="block w-full rounded-xl border border-line bg-surface p-3 text-left text-[13px] text-ink-2 transition hover:border-ink-2 hover:text-ink"
            >
              “{p}”
            </button>
          ))}
        </section>
        <Card className="flex gap-3 p-4 text-xs text-ink-2">
          <ShieldCheck className="size-5 shrink-0 text-good" />
          <p>
            Agents edit through validated operations only: no code execution, no access to other people's
            private dashboards, and a version for every change. You can revoke a connection at any time in
            Settings.
          </p>
        </Card>
      </div>
    </Drawer>
  );
}
