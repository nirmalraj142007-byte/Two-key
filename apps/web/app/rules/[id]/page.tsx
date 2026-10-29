import { type Enforcement, fingerprint as fingerprintOf, RuleCardSchema } from '@twokey/core';
import { merchants, ruleCards } from '@twokey/db';
import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { db } from '@/lib/db';
import { ruleLines } from '@/lib/rules-view';
import { requireUser } from '@/lib/session';
import { SignedCardView } from './signed-card';

export const metadata: Metadata = { title: 'Your signed rules · Two-Key' };

async function SignedCard({ params }: { params: PageProps<'/rules/[id]'>['params'] }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  // Tenancy: another user's card is the same 404 as a missing one.
  const [row] = await db()
    .select()
    .from(ruleCards)
    .where(and(eq(ruleCards.id, id), eq(ruleCards.userId, user.userId)))
    .limit(1);
  if (!row) notFound();
  const card = RuleCardSchema.safeParse(row.rules);
  if (!card.success) notFound();
  const stores = await db()
    .select({ id: merchants.id, slug: merchants.slug, displayName: merchants.displayName })
    .from(merchants);
  const lines = ruleLines(card.data, row.enforcement as Enforcement, stores);
  const fingerprint = row.hmac ? fingerprintOf({ sig: row.hmac }) : null;

  return (
    <SignedCardView
      version={row.version}
      status={row.status}
      expiresAt={row.expiresAt}
      fingerprint={fingerprint}
      lines={lines}
    />
  );
}

export default function RuleCardPage(props: PageProps<'/rules/[id]'>) {
  return (
    <Suspense fallback={<LoadingState rows={4} />}>
      <SignedCard params={props.params} />
    </Suspense>
  );
}
