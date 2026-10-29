'use client';

import { CopyIcon } from 'lucide-react';
import Link from 'next/link';
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

/** `?__state=` screenshots only (lib/test-states.ts). */
const FIXTURE_TOKEN = 'tk_agent_example-token-for-screenshots-only';

function forcedState(forced: 'loading' | 'error' | 'partial' | undefined): ActionState<Issued> {
  if (forced === 'partial') {
    return { status: 'ok', data: { token: FIXTURE_TOKEN, mcpUrl: 'http://localhost:4100/mcp' } };
  }
  if (forced === 'error') {
    return {
      status: 'error',
      failure: {
        message: "We couldn't create a token. Nothing was changed.",
        next: { label: 'Try again' },
      },
    };
  }
  return idle;
}

export function ExternalAgentToken({
  alreadyIssued,
  firstProposal,
  forced,
}: {
  alreadyIssued: boolean;
  /** The current token's agent has proposed at least one purchase. */
  firstProposal: boolean;
  forced?: 'loading' | 'error' | 'partial' | undefined;
}) {
  const [state, action, actionPending] = useActionState(createAgentToken, forcedState(forced));
  const pending = actionPending || forced === 'loading';

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
        <p role="status" className="text-sm text-text-muted">
          Waiting for your agent’s first proposal. It shows up in History.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.status === 'error' && !pending ? <FailureNotice failure={state.failure} /> : null}
      {firstProposal ? (
        <div className="flex flex-col gap-1">
          <Banner tone="info" text="First proposal received from your agent." />
          <Link href="/history" className="text-sm font-medium text-accent">
            See it in History
          </Link>
        </div>
      ) : alreadyIssued ? (
        <p className="text-sm text-text-muted">Token already issued — create a new one.</p>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-text">Catalog</legend>
        <label className="flex items-start gap-2 text-sm text-text">
          <input type="radio" name="mode" value="demo" defaultChecked className="mt-1" />
          <span>
            Demo — the fictional sandbox stores. Use this to try it: live mode finds no purchasable
            items in the PayPal sandbox.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-text">
          <input type="radio" name="mode" value="live" className="mt-1" />
          <span>Live — real product search.</span>
        </label>
      </fieldset>
      <Button type="submit" size="lg" className="w-fit" disabled={pending}>
        {pending ? 'Creating…' : alreadyIssued ? 'Create a new token' : 'Create agent token'}
      </Button>
    </form>
  );
}
