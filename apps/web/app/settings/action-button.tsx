'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import type { SettingsResult } from './actions';

const idle: SettingsResult = { status: 'idle' };

/** One button bound to one settings action, with its one-sentence failure under it. */
export function ActionButton({
  action,
  label,
  pendingLabel,
  describedBy,
  forced,
}: {
  action: (prev: SettingsResult) => Promise<SettingsResult>;
  label: string;
  pendingLabel: string;
  describedBy?: string;
  /** `?__state=` screenshots only (lib/test-states.ts). */
  forced?: 'saving' | SettingsResult | undefined;
}) {
  const [state, run, actionPending] = useActionState(
    action,
    forced && forced !== 'saving' ? forced : idle,
  );
  const pending = actionPending || forced === 'saving';
  return (
    <form action={run} className="flex flex-col items-start gap-1">
      <Button
        type="submit"
        variant="outline"
        className="h-11 px-4"
        disabled={pending}
        aria-describedby={describedBy}
      >
        {pending ? pendingLabel : label}
      </Button>
      {state.status === 'error' && !pending ? (
        <p role="alert" className="text-sm text-state-blocked-fg">
          {state.message}
        </p>
      ) : null}
      {state.status === 'ok' && !pending ? (
        <p role="status" className="text-sm text-text-muted">
          Saved.
        </p>
      ) : null}
    </form>
  );
}
