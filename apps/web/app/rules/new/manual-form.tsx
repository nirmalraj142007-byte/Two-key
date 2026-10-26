'use client';

import { useActionState, useEffect, useState } from 'react';
import { PartialNotice } from '@/components/twokey/state-panels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { DraftView, StoreOption } from '@/lib/rules-view';
import { type ActionState, saveManualDraft } from '../../onboarding/actions';
import { FailureNotice } from '../../onboarding/failure-notice';

const idle: ActionState<DraftView> = { status: 'idle' };
const FIELD = 'flex flex-col gap-1.5';
const LABEL = 'text-sm font-medium text-text';
const SELECT =
  'h-8 rounded-md border border-input bg-transparent px-2.5 text-sm text-text outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring';

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Fallback when the AI rule builder is unavailable: the same fields, typed by hand. */
export function ManualRulesForm({
  stores,
  onDraft,
}: {
  stores: StoreOption[];
  onDraft: (draft: DraftView) => void;
}) {
  const [state, action, pending] = useActionState(saveManualDraft, idle);
  const [defaults] = useState(() => ({ expires: inDays(30), min: inDays(1) }));

  useEffect(() => {
    if (state.status === 'ok' && state.data.card) onDraft(state.data);
  }, [state, onDraft]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Enter your rules by hand</CardTitle>
        <CardDescription>
          The rule builder is unavailable right now. Fill in the same rules yourself.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-5">
          <fieldset className={FIELD}>
            <legend className={`${LABEL} mb-1.5`}>Stores the agent may buy from</legend>
            {stores.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" name="stores" value={s.slug} className="size-4" />
                {s.displayName}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={FIELD}>
              <label htmlFor="perItemCapUsd" className={LABEL}>
                Most per item ($)
              </label>
              <Input
                id="perItemCapUsd"
                name="perItemCapUsd"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                required
              />
            </div>
            <div className={FIELD}>
              <label htmlFor="perOrderCapUsd" className={LABEL}>
                Most per order ($, optional)
              </label>
              <Input
                id="perOrderCapUsd"
                name="perOrderCapUsd"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
              />
            </div>
            <div className={FIELD}>
              <label htmlFor="maxQty" className={LABEL}>
                Most items per order
              </label>
              <Input id="maxQty" name="maxQty" type="number" min="1" max="20" defaultValue="1" />
            </div>
            <div className={FIELD}>
              <span className={LABEL}>How often</span>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Most purchases"
                  name="maxPurchases"
                  type="number"
                  min="1"
                  max="50"
                  defaultValue="5"
                  className="w-20"
                />
                <span className="text-sm text-text-muted">per</span>
                <select aria-label="Period" name="windowHours" defaultValue="24" className={SELECT}>
                  <option value="24">day</option>
                  <option value="168">week</option>
                  <option value="720">30 days</option>
                </select>
              </div>
            </div>
            <div className={FIELD}>
              <label htmlFor="expiresOn" className={LABEL}>
                Rules end on
              </label>
              <Input
                id="expiresOn"
                name="expiresOn"
                type="date"
                min={defaults.min}
                defaultValue={defaults.expires}
                required
              />
            </div>
          </div>
          {state.status === 'ok' && !state.data.card
            ? state.data.needsInput.map((n) => <PartialNotice key={n} text={`Add ${n}.`} />)
            : null}
          {state.status === 'error' && !pending ? <FailureNotice failure={state.failure} /> : null}
          <Button type="submit" size="lg" className="w-fit" disabled={pending}>
            {pending ? 'Saving…' : 'Review my rules'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
