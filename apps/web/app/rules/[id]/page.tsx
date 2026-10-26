import { type Enforcement, fingerprint as fingerprintOf, RuleCardSchema } from '@twokey/core';
import { merchants, ruleCards } from '@twokey/db';
import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { RuleLine } from '@/components/twokey/rule-line';
import { LoadingState } from '@/components/twokey/state-panels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { db } from '@/lib/db';
import { ruleLines } from '@/lib/rules-view';
import { requireUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Your signed rules · Two-Key' };

const STATUS_TEXT = {
  signed: 'Signed',
  draft: 'Draft — not signed',
  revoked: 'Replaced',
  expired: 'Expired',
} as const;

const fmt = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);

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
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-xl">Your rules, version {row.version}</CardTitle>
          <Badge variant="outline">{STATUS_TEXT[row.status]}</Badge>
        </div>
        <CardDescription className="text-base">
          {row.status === 'signed' ? 'From here, no AI decides.' : 'These rules are not active.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-text-muted">Expires</dt>
          <dd className="text-text">{row.expiresAt ? fmt(row.expiresAt) : '—'}</dd>
          <dt className="text-text-muted">Fingerprint</dt>
          <dd className="font-mono text-text" data-testid="fingerprint">
            {fingerprint ?? 'Not signed'}
          </dd>
        </dl>
        <div className="divide-y divide-border">
          {lines.map((l) => (
            <RuleLine key={l.key} label={l.label} value={l.value} enforcement={l.enforcement} />
          ))}
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">
        {row.status === 'signed' ? (
          <Button asChild size="lg">
            <Link href="/onboarding/agent">Continue to your agent</Link>
          </Button>
        ) : null}
        <Button asChild variant="outline" size="lg">
          <Link href="/rules/new">Change rules</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

export default function RuleCardPage(props: PageProps<'/rules/[id]'>) {
  return (
    <Suspense fallback={<LoadingState rows={4} />}>
      <SignedCard params={props.params} />
    </Suspense>
  );
}
