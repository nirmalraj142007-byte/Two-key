'use client';

import { CopyIcon } from 'lucide-react';
import { useActionState } from 'react';
import { toast } from 'sonner';
import { Banner } from '@/components/twokey/banner';
import { Button } from '@/components/ui/button';
import { type ActionState, createAgentToken } from '../actions';
import { FailureNotice } from '../failure-notice';

type Issued = { token: string; mcpUrl: string };
const idle: ActionState<Issued> = { status: 'idle' };

function CopyRow({ label, value }: { label: string; value: string }) {
  const copy = () =>
    navigator.clipboard.writeText(value).then(
      () => toast(`${label} copied`),
      () => toast('Copy failed — select the text and copy it'),
    );
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code
          data-testid={label === 'Agent token' ? 'agent-token' : undefined}
          className="min-w-0 flex-1 overflow-x-auto rounded-sm border border-border bg-surface px-3 py-2 font-mono text-sm text-text select-all"
        >
          {value}
        </code>
        <Button variant="outline" size="icon" onClick={copy} aria-label={`Copy ${label}`}>
          <CopyIcon />
        </Button>
      </div>
    </div>
  );
}

export function ExternalAgentToken({ alreadyIssued }: { alreadyIssued: boolean }) {
  const [state, action, pending] = useActionState(createAgentToken, idle);

  if (state.status === 'ok') {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="warning" text="This token is shown once. Copy it now." />
        <CopyRow label="MCP URL" value={state.data.mcpUrl} />
        <CopyRow label="Agent token" value={state.data.token} />
        <p className="text-sm text-text-muted">
          Send it as <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>. A new
          token replaces this one.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.status === 'error' && !pending ? <FailureNotice failure={state.failure} /> : null}
      {alreadyIssued ? (
        <p className="text-sm text-text-muted">Token already issued — create a new one.</p>
      ) : null}
      <Button type="submit" size="lg" className="w-fit" disabled={pending}>
        {pending ? 'Creating…' : alreadyIssued ? 'Create a new token' : 'Create agent token'}
      </Button>
    </form>
  );
}
