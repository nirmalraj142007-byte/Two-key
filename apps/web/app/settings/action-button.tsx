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
}: {
  action: (prev: SettingsResult) => Promise<SettingsResult>;
  label: string;
  pendingLabel: string;
  describedBy?: string;
}) {
  const [state, run, pending] = useActionState(action, idle);
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
    </form>
  );
}
