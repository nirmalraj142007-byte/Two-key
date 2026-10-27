import { formatUSD } from '@twokey/core/money';
import type { MerchantBalance } from '@/lib/merchants-view';
import { cn } from '@/lib/utils';
import { Money } from './money';

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * One sandbox business account. The main figure is the gross amount Two-Key captured to it;
 * PayPal's own balance (after fees) is secondary, or a note that the figure is computed.
 */
export function MerchantCard({ item, className }: { item: MerchantBalance; className?: string }) {
  const attacker = item.role === 'attacker';
  return (
    <article
      data-slot="merchant-card"
      data-merchant={item.slug}
      data-role={item.role}
      aria-labelledby={`merchant-${item.slug}`}
      className={cn(
        'flex flex-col gap-4 rounded-lg bg-surface-raised p-5',
        attacker ? 'border-2 border-text/40' : 'border border-border',
        className,
      )}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 id={`merchant-${item.slug}`} className="text-lg font-medium text-text">
            {item.displayName}
          </h2>
          <p className="text-xs uppercase tracking-wide text-text-muted">
            {attacker ? 'Attacker (sandbox)' : 'Allowed store (sandbox)'}
          </p>
        </div>
        {item.paypalMerchantId ? (
          <p className="font-mono text-xs text-text-muted">
            <span className="sr-only">PayPal merchant ID </span>
            {item.paypalMerchantId}
          </p>
        ) : null}
      </header>

      <div className="flex flex-col gap-1">
        <p className="text-sm text-text-muted">Received through Two-Key (gross captured)</p>
        <Money
          cents={item.grossCapturedCents}
          currency="USD"
          className={cn('font-medium text-text', attacker ? 'text-3xl' : 'text-2xl')}
        />
      </div>

      <footer className="flex flex-col gap-0.5 border-t border-border pt-3 text-sm text-text-muted">
        <p>
          Payments received (from PayPal):{' '}
          <span className="font-medium tabular-nums text-text" data-testid="payments-received">
            {item.paypalPaymentsReceived ?? 'unavailable'}
          </span>
        </p>
        <p className="text-xs">
          PayPal’s transaction log can lag up to a few hours
          {item.paypalTransactionsAsOf
            ? ` (last updated ${TIME.format(new Date(item.paypalTransactionsAsOf))})`
            : ''}
          .
        </p>
        {item.source === 'paypal' && item.paypalBalanceCents !== null ? (
          <p>
            PayPal balance (incl. $5,000 sandbox starting funds):{' '}
            <span className="tabular-nums text-text">{formatUSD(item.paypalBalanceCents)}</span>
          </p>
        ) : (
          <p>
            <span className="font-medium text-text">computed from Two-Key records</span>
            {' · '}PayPal didn’t report a balance for this account
          </p>
        )}
        <p className="text-xs">As of {TIME.format(new Date(item.asOf))}</p>
      </footer>
    </article>
  );
}
