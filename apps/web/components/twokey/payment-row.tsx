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
      {/* Product and price, then store and state: in the console's narrow column a wide badge
          ("Blocked · no PayPal order") beside the title squeezed it to "Digital g…". */}
      <div className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 min-w-0 break-words text-base font-medium text-text">
          {product}
        </span>
        <Money cents={cents} currency="USD" className="shrink-0 text-base font-medium text-text" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="text-sm text-text-muted">{merchant}</span>
        <StateBadge state={state} />
      </div>
      {reason ? <p className="text-sm text-text-muted">{reason}</p> : null}
      {idList.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{idList}</div>
      ) : null}
    </Tag>
  );
}
