import { type Enforcement, RuleCardSchema } from '@twokey/core';
import { merchants, ruleCards } from '@twokey/db';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import type { ProposalView } from '@/lib/console-view';
import { db } from '@/lib/db';
import { webEnv } from '@/lib/env';
import { ruleLines } from '@/lib/rules-view';
import { requireUser } from '@/lib/session';
import { getProgress } from '../onboarding/progress';
import { recentProposals } from './actions';
import { AgentConsole, type CardSummary } from './console';

export const metadata: Metadata = { title: 'Agent console · Two-Key' };

/** The signed, unexpired card the gateway will check proposals against, as a few lines. */
async function activeCard(userId: string): Promise<CardSummary | null> {
  const [row] = await db()
    .select()
    .from(ruleCards)
    .where(
      and(
        eq(ruleCards.userId, userId),
        eq(ruleCards.status, 'signed'),
        gt(ruleCards.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(ruleCards.version))
    .limit(1);
  if (!row) return null;
  const card = RuleCardSchema.safeParse(row.rules);
  if (!card.success) return null;
  const stores = await db()
    .select({ id: merchants.id, slug: merchants.slug, displayName: merchants.displayName })
    .from(merchants);
  const lines = ruleLines(card.data, row.enforcement as Enforcement, stores);
  return {
    id: row.id,
    version: row.version,
    lines: lines.map(({ key, label, value, enforcement }) => ({ key, label, value, enforcement })),
  };
}

async function Console() {
  const user = await requireUser();
  const [progress, card, proposals] = await Promise.all([
    getProgress(),
    activeCard(user.userId),
    recentProposals().catch((): ProposalView[] | null => null),
  ]);
  return (
    <AgentConsole
      gatewayUrl={webEnv().GATEWAY_URL}
      card={card}
      vaultConnected={progress?.vaultConnected ?? true}
      initialProposals={proposals ?? []}
      historyFailed={proposals === null}
    />
  );
}

export default function AgentPage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Agent console</h1>
        <p className="text-base text-text-muted">
          The agent can propose a purchase. Only Two-Key, checking your signed rules, can pay.
        </p>
      </header>
      <Suspense fallback={<LoadingState rows={3} />}>
        <Console />
      </Suspense>
    </main>
  );
}
