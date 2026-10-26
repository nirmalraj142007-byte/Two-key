import Link from 'next/link';
import type { ProposalView } from '@/lib/console-view';
import { cn } from '@/lib/utils';
import { Countdown } from './countdown';
import { Money } from './money';
import { PayPalId } from './paypal-id';
import { type BadgeState, StateBadge } from './state-badge';

/** Console views never include eval sessions, so 'recorded' does not reach a card. */
export function badgeState(state: ProposalView['state']): BadgeState {
  return state === 'recorded' ? 'failed' : state;
}

/** One proposed purchase as the gateway decided it, updated live. */
export function ProposalCard({ p, className }: { p: ProposalView; className?: string }) {
  const state = badgeState(p.state);
  const held = p.state === 'held';
  return (
    <article
      data-slot="proposal-card"
      data-proposal-id={p.proposalId}
      data-state={state}
      aria-label={`${p.product} at ${p.merchant}`}
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 shadow-xs',
        className,
      )}
    >
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="truncate text-base font-medium text-text">
            {p.product}
            {p.qty > 1 ? ` × ${p.qty}` : ''}
          </h3>
          <span className="text-sm text-text-muted">{p.merchant}</span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Money cents={p.amountCents} currency="USD" className="text-base font-medium text-text" />
          <StateBadge state={state} />
        </div>
      </header>
      <p data-slot="proposal-reason" className="text-sm text-text">
        {p.reason}
      </p>
      {held && p.holdDeadlineAt ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-3 py-2">
          <Countdown deadline={p.holdDeadlineAt} />
          {p.approvalId ? (
            <Link
              href={`/approvals/${p.approvalId}`}
              className="text-sm font-medium text-accent underline-offset-4 hover:underline"
            >
              Review this hold
            </Link>
          ) : null}
        </div>
      ) : null}
      {p.paymentId ? (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
          <div className="flex items-center gap-1">
            <dt>Buyer present:</dt>
            <dd className="font-medium text-text">{p.buyerPresent ? 'yes' : 'no'}</dd>
          </div>
          {p.orderId ? <PayPalId id={p.orderId} kind="order" /> : null}
          {p.authorizationId ? <PayPalId id={p.authorizationId} kind="authorization" /> : null}
          {p.captureId ? <PayPalId id={p.captureId} kind="capture" /> : null}
        </dl>
      ) : null}
    </article>
  );
}
