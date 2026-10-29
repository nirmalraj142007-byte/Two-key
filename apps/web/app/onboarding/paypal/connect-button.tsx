'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import type { Failure } from '@/lib/onboarding';
import { type ActionState, startPayPalConnect } from '../actions';
import { FailureNotice } from '../failure-notice';

const idle: ActionState = { status: 'idle' };

export function ConnectPayPal({
  reconnect = false,
  forced,
}: {
  reconnect?: boolean;
  /** `?__state=` screenshots only (lib/test-states.ts). */
  forced?: { pending: true } | { failure: Failure } | undefined;
}) {
  const initial: ActionState =
    forced && 'failure' in forced ? { status: 'error', failure: forced.failure } : idle;
  const [state, action, actionPending] = useActionState(startPayPalConnect, initial);
  const pending = actionPending || (forced !== undefined && 'pending' in forced);
  return (
    <form action={action} className="flex flex-col gap-4">
      {state.status === 'error' && !pending ? <FailureNotice failure={state.failure} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending
            ? 'Opening PayPal…'
            : state.status === 'error'
              ? 'Retry'
              : reconnect
                ? 'Connect a different PayPal account'
                : 'Connect PayPal'}
        </Button>
        {reconnect ? (
          <Button asChild variant="outline" size="lg">
            <Link href="/rules/new">Continue</Link>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
