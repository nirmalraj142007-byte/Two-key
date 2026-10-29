import { fingerprint, toDraftCard } from '@twokey/core';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { loadRegistry } from '@/lib/registry';
import { ruleLines } from '@/lib/rules-view';
import { requireUser } from '@/lib/session';
import { readForced } from '@/lib/test-states';
import { SignedCardView } from '../[id]/signed-card';
import { type Phase, RulesBuilder } from './rules-builder';

export const metadata: Metadata = { title: 'Your rules · Two-Key' };

const FORCED = ['empty', 'loading', 'error', 'partial', 'success'] as const;
const FIXTURE_DRAFT_ID = '01900000-0000-7000-8000-00000000d001';

async function Builder({
  searchParams,
}: {
  searchParams: PageProps<'/rules/new'>['searchParams'];
}) {
  const user = await requireUser();
  const registry = await loadRegistry();
  const stores = registry.map(({ id, slug, displayName }) => ({ id, slug, displayName }));
  const forced = readForced(await searchParams, FORCED);
  if (!forced || forced === 'empty') return <RulesBuilder stores={stores} />;
  if (forced === 'loading') {
    return <RulesBuilder stores={stores} initialPhase={{ kind: 'compiling' }} />;
  }
  if (forced === 'error') return <RulesBuilder stores={stores} initialPhase={{ kind: 'manual' }} />;

  // The demo request run through the deterministic draft step, plus one store that isn't
  // registered, so the review shows advisory badges and a "not in your stores" warning.
  const draft = toDraftCard(
    {
      perItemCapUsd: 70,
      perOrderCapUsd: null,
      stores: ['Stride Supply', 'Peak Outfitters', 'Trailhead Co'],
      categories: null,
      maxQty: 1,
      frequency: null,
      expiresInDays: 7,
      advisory: [{ key: 'size', value: '10', label: 'Size' }],
      unclear: [],
    },
    {
      userId: user.userId,
      registry,
      now: new Date(),
      version: 1,
      defaults: {
        frequency: { maxPurchases: 5, windowHours: 24 },
        holdTimeoutMinutes: 15,
        expiresInDays: 30,
      },
    },
  );
  if (forced === 'partial' || !draft.card) {
    const phase: Phase = { kind: 'review', draft: { draftId: FIXTURE_DRAFT_ID, ...draft } };
    return <RulesBuilder stores={stores} initialPhase={phase} />;
  }
  return (
    <SignedCardView
      version={1}
      status="signed"
      expiresAt={new Date(draft.card.expiresAt)}
      fingerprint={fingerprint({ sig: '9c41e07a5b2d' })}
      lines={ruleLines(draft.card, draft.enforcement, stores)}
    />
  );
}

export default function NewRulesPage(props: PageProps<'/rules/new'>) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Your rules</h1>
        <p className="text-base text-text-muted">
          Say what the agent may buy. You check every rule before anything is signed.
        </p>
      </div>
      <Suspense fallback={<LoadingState rows={2} />}>
        <Builder searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}
