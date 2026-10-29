'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner } from '@/components/twokey/banner';
import { Button } from '@/components/ui/button';
import type { Failure } from '@/lib/onboarding';
import { SAVED_MESSAGE } from '@/lib/onboarding-copy';
import { type ActionState, completePayPalConnect } from '../../actions';
import { FailureNotice } from '../../failure-notice';

/** Saves the approved wallet once on arrival (the server action re-checks the session match). */
const SAVE_FAILED: Failure = { message: 'Not saved — retry.', next: { label: 'Try again' } };

export function CompleteConnection({
  query,
  forced,
}: {
  query: { approval_token_id?: string };
  /** `?__state=` screenshots only (lib/test-states.ts): show this state, call nothing. */
  forced?: 'saving' | 'error' | undefined;
}) {
  const [state, setState] = useState<ActionState | { status: 'saving' }>(
    forced === 'error' ? { status: 'error', failure: SAVE_FAILED } : { status: 'saving' },
  );
  const started = useRef(forced !== undefined);

  const run = useCallback(() => {
    setState({ status: 'saving' });
    completePayPalConnect(query).then(setState, () =>
      setState({ status: 'error', failure: SAVE_FAILED }),
    );
  }, [query]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  }, [run]);

  if (state.status === 'saving' || state.status === 'idle') {
    return (
      <p role="status" className="text-base text-text-muted">
        Saving your PayPal wallet…
      </p>
    );
  }
  if (state.status === 'error') return <FailureNotice failure={state.failure} retry={run} />;
  return <SavedConnection />;
}

export function SavedConnection() {
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info" text={SAVED_MESSAGE} />
      <Button asChild size="lg" className="w-fit">
        <Link href="/rules/new">Continue</Link>
      </Button>
    </div>
  );
}
