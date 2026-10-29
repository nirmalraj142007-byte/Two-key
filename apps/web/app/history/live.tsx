'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryGridHandle } from '@/components/grids/HistoryGrid';
import { EmptyState, ErrorState, LoadingState } from '@/components/twokey/state-panels';
import type { ConsoleEvent } from '@/lib/console-view';
import { useTwoKeyEvents } from '@/lib/events-client';
import { HistoryResponseSchema, type HistoryRow } from '@/lib/history-view';
import { openAuthorizations } from './actions';

// AG Grid loads only on this page, in its own chunk, never during server rendering.
const HistoryGrid = dynamic(() => import('@/components/grids/HistoryGrid'), {
  ssr: false,
  loading: () => <LoadingState rows={4} />,
});

const REFRESH_DEBOUNCE_MS = 1500;

export type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rows: HistoryRow[] };

async function fetchHistory(): Promise<HistoryRow[]> {
  const res = await fetch('/api/history', { cache: 'no-store' });
  if (!res.ok) throw new Error(`history ${res.status}`);
  return HistoryResponseSchema.parse(await res.json()).rows;
}

/** Debounces `fn`: many calls within `ms` run it once, after the last. */
function useDebounced(fn: () => void, ms: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, [fn, ms]);
}

export function HistoryLive({
  gatewayUrl,
  initialOpen,
  forcedLoad,
}: {
  gatewayUrl: string;
  initialOpen: number | null;
  /** `?__state=` screenshots only (lib/test-states.ts): shown as is, never fetched. */
  forcedLoad?: Load | undefined;
}) {
  const [load, setLoad] = useState<Load>(forcedLoad ?? { status: 'loading' });
  const [open, setOpen] = useState<number | null>(initialOpen);
  const grid = useRef<HistoryGridHandle | null>(null);

  const reload = useCallback(() => {
    fetchHistory()
      .then((rows) => setLoad({ status: 'ready', rows }))
      // Keep showing what we had; only a first load failure shows the error panel.
      .catch(() => setLoad((l) => (l.status === 'ready' ? l : { status: 'error' })));
  }, []);
  const refreshStats = useCallback(() => {
    openAuthorizations()
      .then(setOpen)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!forcedLoad) reload();
  }, [reload, forcedLoad]);

  const staleRows = useDebounced(reload, REFRESH_DEBOUNCE_MS);
  const staleStats = useDebounced(refreshStats, REFRESH_DEBOUNCE_MS / 3);

  const onEvent = useCallback(
    (e: ConsoleEvent) => {
      if (e.type === 'payment.updated') {
        if (grid.current) grid.current.onPaymentUpdated(e.data);
        else staleRows();
        staleStats();
      } else if (e.type === 'proposal.created') {
        staleRows();
      } else if (e.type === 'approval.created' || e.type === 'approval.decided') {
        staleStats();
      }
    },
    [staleRows, staleStats],
  );
  useTwoKeyEvents(onEvent, {
    gatewayUrl,
    onOpen: (again) => {
      if (again) {
        reload();
        refreshStats();
      }
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-text-muted" aria-live="polite">
        Open authorizations:{' '}
        <span className="font-medium tabular-nums text-text" data-testid="open-authorizations">
          {open ?? '—'}
        </span>
      </p>
      {load.status === 'loading' ? <LoadingState rows={4} /> : null}
      {load.status === 'error' ? (
        <ErrorState
          title="Couldn’t load your history"
          body="Your purchases are unaffected. Check your connection and try again."
          retry={() => {
            setLoad({ status: 'loading' });
            reload();
          }}
        />
      ) : null}
      {load.status === 'ready' && load.rows.length === 0 ? (
        <EmptyState
          title="No purchases yet"
          body="When the agent proposes a purchase, it appears here with Two-Key’s decision and every PayPal update."
        />
      ) : null}
      {load.status === 'ready' && load.rows.length > 0 ? (
        <HistoryGrid rows={load.rows} handleRef={grid} onStale={staleRows} />
      ) : null}
    </section>
  );
}
