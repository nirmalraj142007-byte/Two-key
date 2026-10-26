import { cn } from '@/lib/utils';
import { Money } from './money';
import { PayPalId } from './paypal-id';
import { type BadgeState, StateBadge } from './state-badge';

export interface PaymentIds {
  orderId?: string | null;
  authorizationId?: string | null;
  captureId?: string | null;
}

export interface PaymentRowProps {
  product: string;
  merchant: string;
  cents: number;
  state: BadgeState;
  /** One plain sentence. Blocked rows end with "No PayPal order created." */
  reason?: string;
  ids: PaymentIds;
  /** Render as <li> inside a list, or <div> elsewhere. */
  as?: 'div' | 'li';
  className?: string;
}

export function PaymentRow({
  product,
  merchant,
  cents,
  state,
  reason,
  ids,
  as: Tag = 'div',
  className,
}: PaymentRowProps) {
  const idList = [
    ids.orderId ? <PayPalId key="order" id={ids.orderId} kind="order" /> : null,
    ids.authorizationId ? (
      <PayPalId key="auth" id={ids.authorizationId} kind="authorization" />
    ) : null,
    ids.captureId ? <PayPalId key="capture" id={ids.captureId} kind="capture" /> : null,
  ].filter(Boolean);

  return (
    <Tag
      data-slot="payment-row"
      data-state={state}
      className={cn(
        'flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-base font-medium text-text">{product}</span>
          <span className="text-sm text-text-muted">{merchant}</span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Money cents={cents} currency="USD" className="text-base font-medium text-text" />
          <StateBadge state={state} />
        </div>
      </div>
      {reason ? <p className="text-sm text-text-muted">{reason}</p> : null}
      {idList.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{idList}</div>
      ) : null}
    </Tag>
  );
}
