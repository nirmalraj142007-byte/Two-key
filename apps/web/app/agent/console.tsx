'use client';

import { LoaderCircleIcon, SendIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState, useTransition } from 'react';
import { AgentTranscript } from '@/components/twokey/AgentTranscript';
import { Banner } from '@/components/twokey/banner';
import { HistoryStrip } from '@/components/twokey/HistoryStrip';
import { ProposalCard } from '@/components/twokey/ProposalCard';
import { RuleLine } from '@/components/twokey/rule-line';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  type ConsoleEvent,
  mergeProposals,
  type ProposalView,
  type StepEntry,
} from '@/lib/console-view';
import { type LiveStatus, useTwoKeyEvents } from '@/lib/events-client';
import type { RuleLineView } from '@/lib/rules-view';
import { cn } from '@/lib/utils';
import { recentProposals, runStatus, startRun } from './actions';

export interface CardSummary {
  id: string;
  version: number;
  lines: RuleLineView[];
}

const DEMO_REQUEST =
  'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.';
const STATUS_POLL_MS = 2500;

export type Run =
  | { status: 'idle' }
  | { status: 'starting'; message: string }
  | { status: 'running' | 'ended'; message: string; sessionId: string }
  | { status: 'failed'; message: string; sessionId: string | null; reason: string };

function LiveIndicator({ status }: { status: LiveStatus }) {
  const text =
    status === 'live' ? 'Live' : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <span
      data-slot="live-indicator"
      data-status={status}
      role="status"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          status === 'live' ? 'bg-state-captured-fg' : 'animate-pulse bg-text-muted',
        )}
      />
      {text}
    </span>
  );
}

function RunNote({ run, onRetry }: { run: Run; onRetry: () => void }) {
  if (run.status === 'starting' || run.status === 'running') {
    return (
      <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
        <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
        {run.status === 'starting' ? 'Starting the agent…' : 'The agent is shopping…'}
      </p>
    );
  }
  if (run.status === 'ended') {
    return <p className="text-sm text-text-muted">The agent finished.</p>;
  }
  if (run.status === 'failed') {
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <p className="text-sm text-text">{run.reason}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return null;
}

export function AgentConsole({
  gatewayUrl,
  card,
  vaultConnected,
  initialProposals,
  historyFailed,
  initialRun,
  initialSteps,
}: {
  gatewayUrl: string;
  card: CardSummary | null;
  vaultConnected: boolean;
  initialProposals: ProposalView[];
  historyFailed: boolean;
  /** `?__state=` screenshots only (lib/test-states.ts). A forced run is never polled. */
  initialRun?: Run | undefined;
  initialSteps?: Record<string, StepEntry[]> | undefined;
}) {
  const [draft, setDraft] = useState('');
  const [run, setRun] = useState<Run>(initialRun ?? { status: 'idle' });
  const [steps, setSteps] = useState<Record<string, StepEntry[]>>(initialSteps ?? {});
  const [proposals, setProposals] = useState(initialProposals);
  /** The latest session seen on the stream: followed when no run was started from this tab. */
  const [seen, setSeen] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const catchUp = useCallback(() => {
    recentProposals()
      .then((items) => setProposals((prev) => mergeProposals(prev, items)))
      .catch(() => undefined); // the next reconnect tries again
  }, []);

  const onEvent = useCallback((e: ConsoleEvent) => {
    switch (e.type) {
      case 'agent.step': {
        const { sessionId, entry } = e.data;
        setSteps((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), entry] }));
        setSeen(sessionId);
        return;
      }
      case 'proposal.created':
        setSeen(e.data.sessionId);
        setProposals((prev) => mergeProposals(prev, [e.data]));
        return;
      case 'payment.updated':
        setProposals((prev) => mergeProposals(prev, [e.data]));
        return;
      default:
        // Holds carry their approval on the payment.updated snapshot; approvals UI is phase 18.
        return;
    }
  }, []);

  const live = useTwoKeyEvents(onEvent, {
    gatewayUrl,
    // Anything that happened while the stream was down is in the last 10 proposals.
    onOpen: catchUp,
  });

  const sessionId = ('sessionId' in run ? run.sessionId : null) ?? seen;

  // The runner sends no event when a session ends, so ask while it runs.
  useEffect(() => {
    if (run.status !== 'running' || run === initialRun) return;
    const id = run.sessionId;
    const t = setInterval(() => {
      runStatus(id)
        .then((s) => {
          if (s.status === 'ended' || s.status === 'failed') {
            setSteps((prev) => ({ ...prev, [id]: s.steps }));
          }
          if (s.status === 'ended') {
            setRun((r) =>
              r.status === 'running' && r.sessionId === id ? { ...r, status: 'ended' } : r,
            );
          } else if (s.status === 'failed') {
            setRun((r) =>
              r.status === 'running' && r.sessionId === id
                ? { status: 'failed', message: r.message, sessionId: id, reason: s.reason }
                : r,
            );
          }
        })
        .catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [run, initialRun]);

  function send(message: string) {
    setRun({ status: 'starting', message });
    startTransition(async () => {
      const res = await startRun(message);
      if (res.ok) {
        setRun({ status: 'running', message, sessionId: res.sessionId });
        setDraft('');
      } else {
        setRun({ status: 'failed', message, sessionId: null, reason: res.message });
      }
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const message = draft.trim() || DEMO_REQUEST;
    send(message);
  }

  const busy = run.status === 'starting' || run.status === 'running';
  const ready = card !== null && vaultConnected;
  const currentSteps = sessionId ? (steps[sessionId] ?? []) : [];
  const currentCards = sessionId ? proposals.filter((p) => p.sessionId === sessionId) : [];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,18rem)]">
      {/* Chat */}
      <section aria-labelledby="chat-title" className="flex flex-col gap-4">
        <h2 id="chat-title" className="sr-only">
          Chat
        </h2>
        {!vaultConnected ? (
          <div className="flex flex-col gap-2">
            <Banner tone="warning" text="Connect PayPal first." />
            <Link href="/onboarding/paypal" className="text-sm font-medium text-accent">
              Connect PayPal
            </Link>
          </div>
        ) : null}
        {card ? (
          <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
            <p className="text-sm font-medium text-text">
              Checking against your rules, version {card.version}
            </p>
            <div className="divide-y divide-border">
              {card.lines.slice(0, 4).map((l) => (
                <RuleLine key={l.key} label={l.label} value={l.value} enforcement={l.enforcement} />
              ))}
            </div>
            <Link href={`/rules/${card.id}`} className="text-xs font-medium text-accent">
              See all rules
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Banner tone="warning" text="Sign your rules first." />
            <Link href="/rules/new" className="text-sm font-medium text-accent">
              Build my rules
            </Link>
          </div>
        )}
        {run.status !== 'idle' ? (
          <div className="flex flex-col gap-2">
            <p className="self-end rounded-lg bg-surface px-3 py-2 text-sm text-text">
              {run.message}
            </p>
            <RunNote run={run} onRetry={() => send(run.message)} />
          </div>
        ) : null}
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <label htmlFor="agent-message" className="text-sm font-medium text-text">
            What should the agent buy?
          </label>
          <Textarea
            id="agent-message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={DEMO_REQUEST}
            maxLength={2000}
            rows={3}
          />
          <Button type="submit" disabled={busy || !ready} className="self-end">
            <SendIcon aria-hidden="true" />
            Send to agent
          </Button>
        </form>
      </section>

      {/* Steps and cards */}
      <section aria-labelledby="steps-title" className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id="steps-title" className="text-sm font-medium text-text-muted">
            What the agent is doing
          </h2>
          <LiveIndicator status={live} />
        </div>
        {sessionId === null ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
            <p>Send a request. The agent's steps and every purchase it proposes appear here.</p>
            {ready && !busy ? (
              <Button variant="outline" size="sm" onClick={() => send(DEMO_REQUEST)}>
                Try the suggested request
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <AgentTranscript steps={currentSteps} />
            <div className="flex flex-col gap-3">
              {currentCards.map((p) => (
                <ProposalCard key={p.proposalId} p={p} />
              ))}
            </div>
          </>
        )}
      </section>

      {/* History */}
      <aside className="flex flex-col gap-3">
        {historyFailed ? (
          <p className="text-xs text-text-muted">
            Recent purchases will load when the stream connects.
          </p>
        ) : null}
        <HistoryStrip items={proposals} />
      </aside>
    </div>
  );
}
