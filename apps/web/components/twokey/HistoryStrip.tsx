import type { ProposalView } from '@/lib/console-view';
import { cn } from '@/lib/utils';
import { badgeState } from './ProposalCard';
import { PaymentRow } from './payment-row';

const SHOWN = 8;

/** The last purchases the agent proposed, newest first, as the events stream moves them. */
export function HistoryStrip({ items, className }: { items: ProposalView[]; className?: string }) {
  const shown = items.slice(0, SHOWN);
  return (
    <section
      data-slot="history-strip"
      aria-labelledby="history-strip-title"
      className={cn('flex flex-col gap-3', className)}
    >
      <h2 id="history-strip-title" className="text-sm font-medium text-text-muted">
        Recent purchases
      </h2>
      {shown.length === 0 ? (
        <p className="text-sm text-text-muted">
          Nothing yet. Purchases show up here as they happen.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((p) => (
            <PaymentRow
              key={p.proposalId}
              as="li"
              product={p.product}
              merchant={p.merchant}
              cents={p.amountCents}
              state={badgeState(p.state)}
              ids={{ orderId: p.orderId, captureId: p.captureId }}
              className="p-3"
            />
          ))}
        </ul>
      )}
    </section>
  );
}
