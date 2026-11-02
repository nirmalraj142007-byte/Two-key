import { type Enforcement, RuleCardSchema } from '@twokey/core';
import { merchants, ruleCards } from '@twokey/db';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReplayConsole } from '@/components/twokey/ReplayConsole';
import { LoadingState } from '@/components/twokey/state-panels';
import { FAILURE_TEXT, type ProposalView } from '@/lib/console-view';
import { db } from '@/lib/db';
import { webEnv } from '@/lib/env';
import { fallbackReason } from '@/lib/golden-run';
import { ruleLines } from '@/lib/rules-view';
import { scriptedAllowed } from '@/lib/scripted-model';
import { requireUser } from '@/lib/session';
import {
  DEMO_REQUEST,
  FIXTURE_SESSION,
  fixtureCardLines,
  fixtureFinalProposals,
  fixtureProposal,
  fixtureSteps,
} from '@/lib/state-fixtures';
import { readForced } from '@/lib/test-states';
import { getProgress } from '../onboarding/progress';
import { recentProposals } from './actions';
import { AgentConsole, type CardSummary, type Run } from './console';

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

const FORCED = ['empty', 'loading', 'error', 'partial', 'success', 'replay'] as const;

/** The gateway's public PayPal health (cached 60 s there). Unreachable counts as not degraded:
 * a run that then fails to start switches to the replay on its own. */
async function paypalDegraded(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/healthz/paypal', webEnv().GATEWAY_URL), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const body = (await res.json()) as { degraded?: unknown };
    return body.degraded === true;
  } catch {
    return false;
  }
}

/** `?__state=` screenshots only (lib/test-states.ts): the console mid-run, failed or done. */
function forcedConsole(
  forced: Exclude<(typeof FORCED)[number], 'replay'>,
  real: CardSummary | null,
) {
  const card = real ?? { id: FIXTURE_SESSION, version: 1, lines: fixtureCardLines() };
  const sessionId = FIXTURE_SESSION;
  const steps = { [sessionId]: fixtureSteps() };
  const base = { message: DEMO_REQUEST, sessionId };
  const props = {
    empty: { initialProposals: [] },
    loading: {
      initialProposals: [],
      initialRun: { status: 'running', ...base },
      initialSteps: steps,
    },
    error: {
      initialProposals: [],
      initialRun: { status: 'failed', ...base, reason: FAILURE_TEXT.model },
      initialSteps: steps,
    },
    partial: {
      initialProposals: [
        fixtureProposal({
          state: 'authorized',
          reason: 'Inside your rules. Authorized on your saved PayPal wallet.',
          captureId: null,
        }),
      ],
      initialRun: { status: 'ended', ...base },
      initialSteps: steps,
    },
    success: {
      initialProposals: fixtureFinalProposals(),
      initialRun: { status: 'ended', ...base },
      initialSteps: steps,
    },
  } satisfies Record<
    typeof forced,
    { initialProposals: ProposalView[]; initialRun?: Run; initialSteps?: typeof steps }
  >;
  return { card, ...props[forced] };
}

async function Console({ searchParams }: { searchParams: PageProps<'/agent'>['searchParams'] }) {
  const user = await requireUser();
  const forced = readForced(await searchParams, FORCED);
  if (forced === 'replay') return <ReplayConsole />;
  if (forced) {
    const f = forcedConsole(forced, await activeCard(user.userId));
    return (
      <AgentConsole gatewayUrl={webEnv().GATEWAY_URL} vaultConnected historyFailed={false} {...f} />
    );
  }
  const fallback = fallbackReason({
    demoFallback: webEnv().DEMO_FALLBACK,
    paypalDegraded: await paypalDegraded(),
  });
  if (fallback) return <ReplayConsole />;
  const asked = (await searchParams).model;
  const scriptedModel = typeof asked === 'string' && scriptedAllowed(asked) ? asked : undefined;
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
      scriptedModel={scriptedModel}
    />
  );
}

export default function AgentPage(props: PageProps<'/agent'>) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Agent console</h1>
        <p className="text-base text-text-muted">
          The agent can propose a purchase. Only Two-Key, checking your signed rules, can pay.
        </p>
      </header>
      <Suspense fallback={<LoadingState rows={3} />}>
        <Console searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}
