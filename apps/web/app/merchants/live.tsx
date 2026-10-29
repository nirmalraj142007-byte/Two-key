'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MerchantCard } from '@/components/twokey/MerchantCard';
import { ErrorState, PartialNotice } from '@/components/twokey/state-panels';
import type { ConsoleEvent } from '@/lib/console-view';
import { useTwoKeyEvents } from '@/lib/events-client';
import { type MerchantBalance, sortMerchants, sourceNotice } from '@/lib/merchants-view';
import { merchantBalances } from './actions';

const REFRESH_DEBOUNCE_MS = 1000;

export function MerchantBalances({
  gatewayUrl,
  initial,
}: {
  gatewayUrl: string;
  initial: MerchantBalance[] | null;
}) {
  const [items, setItems] = useState(initial);
  const [stale, setStale] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    merchantBalances()
      .then((next) => {
        setItems(next);
        setStale(false);
      })
      // A failed refresh keeps the last figures on screen, marked as possibly out of date.
      .catch(() => setStale(true));
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onEvent = useCallback(
    (e: ConsoleEvent) => {
      if (e.type !== 'payment.updated') return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    },
    [refresh],
  );
  useTwoKeyEvents(onEvent, { gatewayUrl, onOpen: (again) => again && refresh() });

  if (!items) {
    return (
      <ErrorState
        title="Couldn’t load merchant balances"
        body="Nothing about your purchases changed. Check your connection and try again."
        retry={refresh}
      />
    );
  }

  const notice = sourceNotice(items);
  return (
    <div className="flex flex-col gap-4">
      {notice ? <PartialNotice text={notice} /> : null}
      {stale ? (
        <PartialNotice text="Couldn’t refresh the balances. These figures may be out of date." />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {sortMerchants(items).map((m) => (
          <MerchantCard
            key={m.slug}
            item={m}
            className={m.role === 'attacker' ? 'sm:col-span-2' : undefined}
          />
        ))}
      </div>
    </div>
  );
}
