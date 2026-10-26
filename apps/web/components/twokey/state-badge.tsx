import type { PaymentState } from '@twokey/core/payment-state';
import { cn } from '@/lib/utils';

export type BadgeState = PaymentState | 'blocked';

type Tone = 'captured' | 'held' | 'blocked' | 'voided' | 'pending';

const TONE_CLASS: Record<Tone, string> = {
  captured: 'bg-state-captured-bg text-state-captured-fg',
  held: 'bg-state-held-bg text-state-held-fg',
  blocked: 'bg-state-blocked-bg text-state-blocked-fg',
  voided: 'bg-state-voided-bg text-state-voided-fg',
  // In-flight states are neutral: nothing has happened to the money yet.
  pending: 'bg-surface text-text-muted ring-1 ring-inset ring-border',
};

export const STATE_LABEL: Record<BadgeState, { label: string; tone: Tone }> = {
  captured: { label: 'Captured', tone: 'captured' },
  held: { label: 'Waiting for you', tone: 'held' },
  blocked: { label: 'Blocked · no PayPal order', tone: 'blocked' },
  voided: { label: 'Voided · no charge', tone: 'voided' },
  expired: { label: 'Expired · no charge', tone: 'voided' },
  denied: { label: 'Denied · no charge', tone: 'voided' },
  authorizing: { label: 'Authorizing…', tone: 'pending' },
  authorized: { label: 'Authorizing…', tone: 'pending' },
  capture_requested: { label: 'Capturing…', tone: 'pending' },
  void_requested: { label: 'Voiding…', tone: 'pending' },
  failed: { label: 'Not purchased', tone: 'blocked' },
};

export function StateBadge({ state, className }: { state: BadgeState; className?: string }) {
  const { label, tone } = STATE_LABEL[state];
  return (
    <span
      data-slot="state-badge"
      data-state={state}
      className={cn(
        'inline-flex h-6 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium',
        TONE_CLASS[tone],
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
