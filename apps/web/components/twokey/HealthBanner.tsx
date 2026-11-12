'use client';

import { useEffect, useState } from 'react';
import { readForcedState } from '@/lib/test-states';
import { WAKING_TEXT } from '@/lib/waking';
import { Banner } from './banner';

const POLL_MS = 60_000;
/** While the free gateway is waking, check again soon so the note goes as soon as it answers. */
export const WAKING_POLL_MS = 5_000;
export const DEGRADED_TEXT = 'PayPal sandbox is degraded — purchases may be slow';

export type Health = 'ok' | 'waking' | 'degraded';

/** The banner state for one /api/healthz/paypal answer. */
export function healthOf(body: { degraded?: unknown; waking?: unknown; reason?: unknown }): Health {
  if (body.degraded === true) return 'degraded';
  return body.waking === true ? 'waking' : 'ok';
}

/**
 * Polls /api/healthz/paypal (every 60 s; every 5 s while the free gateway is waking) and shows
 * one banner: "waking" while a sleeping gateway starts, "degraded" only when PayPal looks degraded.
 */
export function HealthBanner() {
  const [health, setHealth] = useState<Health>('ok');

  useEffect(() => {
    const forced = readForcedState(new URLSearchParams(window.location.search));
    if (forced === 'degraded' || forced === 'waking') {
      setHealth(forced);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      fetch('/api/healthz/paypal', { cache: 'no-store' })
        .then((r) => r.json() as Promise<{ degraded?: unknown; waking?: unknown }>)
        .then((b) => healthOf(b))
        // The web app itself is unreachable: each screen shows its own error state.
        .catch(() => null)
        .then((h) => {
          if (!alive) return;
          if (h !== null) setHealth(h);
          timer = setTimeout(check, h === 'waking' ? WAKING_POLL_MS : POLL_MS);
        });
    };
    check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  if (health === 'ok') return null;
  return (
    <div data-slot="health-banner" className="border-b border-border bg-surface px-4 py-2">
      <Banner
        tone={health === 'waking' ? 'info' : 'warning'}
        text={health === 'waking' ? WAKING_TEXT : DEGRADED_TEXT}
        className="mx-auto w-full max-w-[1200px]"
      />
    </div>
  );
}
