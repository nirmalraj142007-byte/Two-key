import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { loadRegistry } from '@/lib/registry';
import { requireUser } from '@/lib/session';
import { RulesBuilder } from './rules-builder';

export const metadata: Metadata = { title: 'Your rules · Two-Key' };

async function Builder() {
  await requireUser();
  const stores = (await loadRegistry()).map(({ id, slug, displayName }) => ({
    id,
    slug,
    displayName,
  }));
  return <RulesBuilder stores={stores} />;
}

export default function NewRulesPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Your rules</h1>
        <p className="text-base text-text-muted">
          Say what the agent may buy. You check every rule before anything is signed.
        </p>
      </div>
      <Suspense fallback={<LoadingState rows={2} />}>
        <Builder />
      </Suspense>
    </div>
  );
}
