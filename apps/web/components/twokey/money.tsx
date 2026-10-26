import { formatUSD } from '@twokey/core/money';
import { cn } from '@/lib/utils';

export interface MoneyProps {
  cents: number;
  currency: 'USD';
  /** Amounts inside data grids use the mono face; everywhere else stays sans. */
  inGrid?: boolean;
  className?: string;
}

export function Money({ cents, currency, inGrid = false, className }: MoneyProps) {
  return (
    <span
      data-slot="money"
      data-currency={currency}
      className={cn('tabular-nums whitespace-nowrap', inGrid && 'font-mono', className)}
    >
      {formatUSD(cents)}
    </span>
  );
}
