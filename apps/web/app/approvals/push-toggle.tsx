'use client';

import { BellIcon, BellOffIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  isIOS,
  isStandalone,
  type PushStatus,
  pushStatus,
  registerServiceWorker,
  subscribe,
  unsubscribe,
} from '@/lib/push-client';

/** "Phone alerts" switch: subscribes this browser to approval pushes. */
export function PushToggle({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    setIosHint(isIOS() && !isStandalone());
    void registerServiceWorker().catch(() => undefined);
    pushStatus(vapidPublicKey)
      .then(setStatus)
      .catch(() => setStatus('off'));
  }, [vapidPublicKey]);

  async function run(fn: () => Promise<{ status: PushStatus; message?: string }>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      setStatus(res.status);
      if (res.message) setMessage(res.message);
    } catch {
      setMessage('Could not change alerts. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (status === null) return null;

  return (
    <section
      data-slot="push-toggle"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-text">Phone alerts</h2>
          <p className="text-sm text-text-muted">
            {status === 'enabled'
              ? 'On. This device gets a notification when a purchase is held.'
              : status === 'denied'
                ? 'Blocked in this browser’s settings. Allow notifications for this site, then reload.'
                : status === 'unsupported'
                  ? iosHint
                    ? 'On iPhone, add Two-Key to your Home Screen first (Share → Add to Home Screen), then open it from there.'
                    : 'This browser can’t receive alerts. Holds still show up here.'
                  : 'Get a notification on this device when a purchase is held.'}
          </p>
        </div>
        {status === 'off' && vapidPublicKey ? (
          <Button
            className="h-11 px-4"
            disabled={busy}
            onClick={() => run(() => subscribe(vapidPublicKey))}
          >
            <BellIcon aria-hidden="true" />
            Turn on alerts
          </Button>
        ) : null}
        {status === 'enabled' ? (
          <Button
            variant="outline"
            className="h-11 px-4"
            disabled={busy}
            onClick={() => run(unsubscribe)}
          >
            <BellOffIcon aria-hidden="true" />
            Turn off
          </Button>
        ) : null}
      </div>
      {status === 'off' && !vapidPublicKey ? (
        <p className="text-sm text-text-muted">Alerts are not set up on this server yet.</p>
      ) : null}
      {iosHint && status !== 'unsupported' ? (
        <p className="text-sm text-text-muted">
          On iPhone, alerts work only after you add Two-Key to your Home Screen.
        </p>
      ) : null}
      {message ? (
        <p role="alert" className="text-sm text-state-blocked-fg">
          {message}
        </p>
      ) : null}
    </section>
  );
}
