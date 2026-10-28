import type { Outcome } from '@/lib/episodes-view';
import { cn } from '@/lib/utils';

/** Gate outcomes in the StateBadge colours. Evaluation never calls PayPal: these are decisions. */
export const OUTCOME_LABEL: Record<Outcome, string> = {
  capture: 'Capture',
  hold: 'Hold',
  block: 'Block',
  ask_every_time: 'Ask',
};

const TONE: Record<Outcome, string> = {
  capture: 'bg-state-captured-bg text-state-captured-fg',
  hold: 'bg-state-held-bg text-state-held-fg',
  block: 'bg-state-blocked-bg text-state-blocked-fg',
  ask_every_time: 'bg-surface text-text-muted ring-1 ring-inset ring-border',
};

export function OutcomeChip({
  outcome,
  className,
}: {
  outcome: Outcome | null;
  className?: string;
}) {
  if (!outcome) return <span className={cn('text-text-muted', className)}>—</span>;
  return (
    <span
      data-slot="outcome-chip"
      data-outcome={outcome}
      className={cn(
        'inline-flex h-6 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium',
        TONE[outcome],
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}
