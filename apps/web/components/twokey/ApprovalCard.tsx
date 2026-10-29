'use client';

import { CheckIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { decideApproval } from '@/app/approvals/actions';
import { Button } from '@/components/ui/button';
import {
  type ApprovalItem,
  type ApprovalState,
  closedSentence,
  isOpen,
  priceLine,
} from '@/lib/approvals-view';
import { cn } from '@/lib/utils';
import { Countdown } from './countdown';
import { Money } from './money';
import { StateBadge } from './state-badge';

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export interface ApprovalCardProps {
  item: ApprovalItem;
  /** Which screen decided: the web inbox or the phone approval page. */
  via: 'web' | 'phone';
  /** Newest payment state from the event stream, if any. */
  liveState?: ApprovalState | undefined;
  /** Called with the new state after this card's own decision. */
  onDecided?: (id: string, state: ApprovalState) => void;
  className?: string;
}

/**
 * One hold: what the agent wants to buy, why Two-Key stopped it, and Approve / Deny. Double-tap
 * safe: both buttons lock on the first press, and a 409 shows the server's own sentence.
 */
export function ApprovalCard({ item, via, liveState, onDecided, className }: ApprovalCardProps) {
  const [pressed, setPressed] = useState<'approve' | 'deny' | null>(null);
  const [ownState, setOwnState] = useState<ApprovalState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [timeUp, setTimeUp] = useState(false);
  // A ref, not state: a second tap in the same frame must already see the lock.
  const lock = useRef(false);

  const state = ownState ?? liveState ?? item.state;
  const open = isOpen({ status: item.status, state }) && !timeUp;

  useEffect(() => {
    const ms = new Date(item.deadlineAt).getTime() - Date.now();
    if (ms <= 0) {
      setTimeUp(true);
      return;
    }
    const t = setTimeout(() => setTimeUp(true), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [item.deadlineAt]);

  async function decide(decision: 'approve' | 'deny') {
    if (lock.current) return;
    lock.current = true;
    setPressed(decision);
    setMessage(null);
    const res = await decideApproval(item.id, decision, via);
    if (res.ok) {
      setOwnState(res.state);
      onDecided?.(item.id, res.state);
      return;
    }
    setMessage(res.message);
    // Unlock only if the hold can still be decided; a 409 means someone (or the timer) already did.
    lock.current = false;
    setPressed(null);
  }

  const qty = item.qty > 1 ? ` × ${item.qty}` : '';

  return (
    <article
      data-slot="approval-card"
      data-state={state}
      aria-labelledby={`approval-${item.id}`}
      className={cn(
        'flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-5',
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={`approval-${item.id}`} className="text-base font-medium text-text">
            {item.product}
            {qty}
          </h2>
          <p className="text-sm text-text-muted">{item.merchant}</p>
        </div>
        <StateBadge state={state} />
      </header>

      <div className="flex flex-col gap-1">
        <Money
          cents={item.amountCents}
          currency="USD"
          className="text-4xl font-semibold tracking-tight text-text"
        />
        <p className="text-sm text-text">{priceLine(item)}</p>
      </div>

      {open ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Countdown deadline={item.deadlineAt} />
            <span className="text-xs text-text-muted">Ignored holds are voided automatically.</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Button
              variant="outline"
              className="h-12 text-base"
              disabled={pressed !== null}
              aria-busy={pressed === 'deny'}
              onClick={() => decide('deny')}
            >
              <XIcon aria-hidden="true" />
              {pressed === 'deny' ? 'Denying…' : 'Deny'}
            </Button>
            <Button
              className="h-12 text-base"
              disabled={pressed !== null}
              aria-busy={pressed === 'approve'}
              onClick={() => decide('approve')}
            >
              <CheckIcon aria-hidden="true" />
              {pressed === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
          </div>
        </>
      ) : (
        // Times are in the reader's own time zone, so server and browser text may differ.
        <p
          role="status"
          suppressHydrationWarning
          className="rounded-sm bg-surface px-3 py-2 text-sm text-text"
        >
          {timeUp && state === 'held'
            ? 'Time is up. Two-Key is voiding this hold. No charge will be made.'
            : closedSentence(item, state, via, (iso) => TIME.format(new Date(iso)))}
        </p>
      )}

      {message ? (
        <p role="alert" className="text-sm text-state-blocked-fg">
          {message}
        </p>
      ) : null}
    </article>
  );
}
