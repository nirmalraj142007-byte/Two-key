'use client';

import { useEffect, useState } from 'react';
import { readForcedState } from '@/lib/test-states';
import { Banner } from './banner';

const POLL_MS = 60_000;
export const DEGRADED_TEXT = 'PayPal sandbox is degraded — purchases may be slow';

/** Polls /api/healthz/paypal every 60 s and shows one banner while PayPal looks degraded. */
export function HealthBanner() {
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (readForcedState(new URLSearchParams(window.location.search)) === 'degraded') {
      setDegraded(true);
      return;
    }
    let alive = true;
    const check = () => {
      fetch('/api/healthz/paypal', { cache: 'no-store' })
        .then((r) => r.json() as Promise<{ degraded?: unknown }>)
        .then((b) => {
          if (alive) setDegraded(b.degraded === true);
        })
        // The web app itself is unreachable: each screen shows its own error state.
        .catch(() => undefined);
    };
    check();
    const t = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!degraded) return null;
  return (
    <div data-slot="health-banner" className="border-b border-border bg-surface px-4 py-2">
      <Banner tone="warning" text={DEGRADED_TEXT} className="mx-auto w-full max-w-[1200px]" />
    </div>
  );
}
