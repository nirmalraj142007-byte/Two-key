import { agentSessions } from '@twokey/db';
import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { db } from '@/lib/db';
import { EXTERNAL_MODEL } from '@/lib/onboarding';
import { requireUser } from '@/lib/session';
import { FailureNotice } from '../failure-notice';
import { getProgress } from '../progress';
import { ExternalAgentToken } from './token-box';

export const metadata: Metadata = { title: 'Your agent · Two-Key' };

async function OwnAgent() {
  const user = await requireUser();
  const progress = await getProgress();
  if (progress && !progress.vaultConnected) {
    return (
      <FailureNotice
        failure={{
          message: 'Connect PayPal first.',
          next: { label: 'Connect PayPal', href: '/onboarding/paypal' },
        }}
      />
    );
  }
  if (progress && !progress.activeCardId) {
    return (
      <FailureNotice
        failure={{
          message: 'Sign your rules first.',
          next: { label: 'Build my rules', href: '/rules/new' },
        }}
      />
    );
  }
  const [issued] = await db()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, user.userId),
        eq(agentSessions.model, EXTERNAL_MODEL),
        eq(agentSessions.status, 'active'),
      ),
    )
    .limit(1);
  return <ExternalAgentToken alreadyIssued={issued !== undefined} />;
}

export default function AgentPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Your agent</h1>
        <p className="text-base text-text-muted">
          The agent can propose purchases. Only Two-Key, checking your signed rules, can pay.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Use the built-in agent</CardTitle>
          <CardDescription>Type what you need; the agent shops inside your rules.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="lg">
            <Link href="/agent">Open the agent</Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Use your own agent (MCP)</CardTitle>
          <CardDescription>
            Connect any MCP client. It gets four tools: search, propose a purchase, check a purchase
            and read your rules. It can never pay, approve or change rules.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<LoadingState rows={1} />}>
            <OwnAgent />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
