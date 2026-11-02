'use client';

import { RotateCcwIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { mergeProposals, type ProposalView, type StepEntry } from '@/lib/console-view';
import {
  GOLDEN_RUN_PATH,
  type GoldenRun,
  GoldenRunSchema,
  REPLAY_FALLBACK_TEXT,
  replayTimeline,
} from '@/lib/golden-run';
import { AgentTranscript } from './AgentTranscript';
import { Banner } from './banner';
import { HistoryStrip } from './HistoryStrip';
import { ProposalCard } from './ProposalCard';

export type ReplayStatus = 'loading' | 'playing' | 'done' | 'unavailable';

export interface ReplayFrame {
  status: ReplayStatus;
  message: string | null;
  steps: StepEntry[];
  cards: ProposalView[];
  history: ProposalView[];
}

/**
 * What a replay shows at one moment. The replay banner is the first thing rendered in every
 * state (loading, playing, done, unavailable): a recording is never shown without it.
 */
export function ReplayView({ frame, onReplay }: { frame: ReplayFrame; onReplay?: () => void }) {
  return (
    <div data-slot="replay-console" className="flex flex-col gap-6">
      <Banner tone="replay" text={REPLAY_FALLBACK_TEXT} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,18rem)]">
        <section aria-labelledby="replay-chat-title" className="flex flex-col gap-3">
          <h2 id="replay-chat-title" className="text-sm font-medium text-text-muted">
            Recorded request
          </h2>
          {frame.message ? (
            <p className="self-end rounded-lg bg-surface px-3 py-2 text-sm text-text">
              {frame.message}
            </p>
          ) : null}
          <p className="text-sm text-text-muted" role="status">
            {frame.status === 'loading'
              ? 'Loading the recording…'
              : frame.status === 'playing'
                ? 'Replaying the recorded agent…'
                : frame.status === 'done'
                  ? 'The recording finished. No new payment was made.'
                  : 'The recording could not load. Reload the page to try again.'}
          </p>
          {frame.status === 'done' && onReplay ? (
            <Button variant="outline" size="sm" onClick={onReplay} className="self-start">
              <RotateCcwIcon aria-hidden="true" />
              Play again
            </Button>
          ) : null}
        </section>
        <section aria-labelledby="replay-steps-title" className="flex min-w-0 flex-col gap-4">
          <h2 id="replay-steps-title" className="text-sm font-medium text-text-muted">
            What the agent did (recorded)
          </h2>
          <AgentTranscript steps={frame.steps} />
          <div className="flex flex-col gap-3">
            {frame.cards.map((p) => (
              <ProposalCard key={p.proposalId} p={p} />
            ))}
          </div>
        </section>
        <aside className="flex flex-col gap-3">
          <HistoryStrip items={frame.history} />
        </aside>
      </div>
    </div>
  );
}

const EMPTY: ReplayFrame = { status: 'loading', message: null, steps: [], cards: [], history: [] };

/** One playback of the recording; remounted (new `key`) to play it again. */
function ReplayPlayer({ run, onReplay }: { run: GoldenRun; onReplay: () => void }) {
  const [frame, setFrame] = useState<ReplayFrame>({ ...EMPTY, status: 'playing' });

  useEffect(() => {
    const timeline = replayTimeline(run, new Date());
    if (timeline.length === 0) {
      setFrame((f) => ({ ...f, status: 'unavailable' }));
      return;
    }
    let session: string | null = null;
    const timers = timeline.map((item, i) =>
      setTimeout(() => {
        setFrame((f) => {
          let { steps, cards, history, message } = f;
          if (item.sessionId && item.sessionId !== session) {
            session = item.sessionId;
            steps = [];
            cards = [];
            message = item.message;
          }
          const e = item.event;
          if (e.type === 'agent.step') steps = [...steps, e.data.entry];
          if (e.type === 'proposal.created' || e.type === 'payment.updated') {
            cards = mergeProposals(cards, [e.data]);
            history = mergeProposals(history, [e.data]);
          }
          const status = i === timeline.length - 1 ? 'done' : 'playing';
          return { status, message, steps, cards, history };
        });
      }, item.at),
    );
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [run]);

  return <ReplayView frame={frame} onReplay={onReplay} />;
}

/**
 * Plays public/golden-run.json through the console's own components, event by event, with the
 * recorded timing (long waits shortened). Used when DEMO_FALLBACK=replay, when PayPal looks
 * degraded, or when a live run could not start or failed.
 */
export function ReplayConsole({ initialRun }: { initialRun?: GoldenRun }) {
  const [run, setRun] = useState<GoldenRun | null>(initialRun ?? null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (run) return;
    let alive = true;
    fetch(GOLDEN_RUN_PATH, { cache: 'force-cache' })
      .then((r) => r.json())
      .then((json: unknown) => {
        const parsed = GoldenRunSchema.safeParse(json);
        if (!alive) return;
        if (parsed.success) setRun(parsed.data);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [run]);

  const replay = useCallback(() => setRound((r) => r + 1), []);
  if (!run) return <ReplayView frame={{ ...EMPTY, status: failed ? 'unavailable' : 'loading' }} />;
  return <ReplayPlayer key={round} run={run} onReplay={replay} />;
}
