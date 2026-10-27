'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApprovalCard } from '@/components/twokey/ApprovalCard';
import { EmptyState, ErrorState, PartialNotice } from '@/components/twokey/state-panels';
import { type ApprovalItem, type ApprovalState, isUrgent } from '@/lib/approvals-view';
import type { ConsoleEvent } from '@/lib/console-view';
import { useTwoKeyEvents } from '@/lib/events-client';
import { approvalById, pendingApprovals } from './actions';

/** Payment state per approval, kept current from payment.updated and approval.decided. */
function useLiveStates(gatewayUrl: string, onChange: () => void) {
  const [states, setStates] = useState<Record<string, ApprovalState>>({});
  const onEvent = useCallback(
    (e: ConsoleEvent) => {
      if (e.type === 'payment.updated' && e.data.approvalId) {
        const { approvalId, state } = e.data;
        if (state !== 'blocked' && state !== 'recorded') {
          setStates((s) => ({ ...s, [approvalId]: state }));
        }
      }
      if (e.type === 'approval.created' || e.type === 'approval.decided') onChange();
    },
    [onChange],
  );
  // On reconnect, catch up on anything missed while the stream was down.
  useTwoKeyEvents(onEvent, { gatewayUrl, onOpen: (again) => again && onChange() });
  return { states, setStates };
}

export function ApprovalsInbox({
  gatewayUrl,
  initial,
  failed,
}: {
  gatewayUrl: string;
  initial: ApprovalItem[];
  failed: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [error, setError] = useState(failed);
  /** Cards decided on this screen stay visible with their outcome until the next reload. */
  const [decided, setDecided] = useState<ApprovalItem[]>([]);
  const [now, setNow] = useState<number | null>(null);

  const refresh = useCallback(() => {
    pendingApprovals()
      .then((next) => {
        setItems(next);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  const { states, setStates } = useLiveStates(gatewayUrl, refresh);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  function onDecided(id: string, state: ApprovalState) {
    setStates((s) => ({ ...s, [id]: state }));
    const card = items.find((i) => i.id === id);
    if (card) setDecided((d) => [{ ...card, state }, ...d.filter((x) => x.id !== id)]);
  }

  const decidedIds = new Set(decided.map((d) => d.id));
  const pending = items.filter((i) => !decidedIds.has(i.id));
  const urgent = now !== null && pending.some((i) => isUrgent(i.deadlineAt, now));

  if (error && pending.length === 0 && decided.length === 0) {
    return (
      <ErrorState
        title="Couldn’t load your holds"
        body="Nothing was approved or denied. Check your connection and try again."
        retry={refresh}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {urgent ? (
        <PartialNotice text="A hold is less than 10 minutes from its deadline. If you don’t decide, it is voided and you are not charged." />
      ) : null}
      {pending.length === 0 && decided.length === 0 ? (
        <EmptyState
          title="Nothing waiting for you"
          body="When the agent proposes a purchase that looks unusual, Two-Key holds it here for your approval."
        />
      ) : null}
      {pending.map((item) => (
        <ApprovalCard
          key={item.id}
          item={item}
          via="web"
          liveState={states[item.id]}
          onDecided={onDecided}
        />
      ))}
      {decided.map((item) => (
        <ApprovalCard key={item.id} item={item} via="web" liveState={states[item.id]} />
      ))}
    </div>
  );
}

/** The phone screen a push opens: one hold, decided with via 'phone'. */
export function PhoneApproval({
  gatewayUrl,
  id,
  initial,
}: {
  gatewayUrl: string;
  id: string;
  initial: ApprovalItem;
}) {
  const [item, setItem] = useState(initial);
  const refresh = useCallback(() => {
    approvalById(id)
      .then((next) => next && setItem(next))
      .catch(() => undefined);
  }, [id]);
  const { states, setStates } = useLiveStates(gatewayUrl, refresh);

  return (
    <ApprovalCard
      item={item}
      via="phone"
      liveState={states[id]}
      onDecided={(_, state) => setStates((s) => ({ ...s, [id]: state }))}
    />
  );
}
