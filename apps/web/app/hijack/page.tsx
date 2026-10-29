import { REPLAY_REASON } from '@twokey/core/hijack';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { SiteFooter } from '@/components/twokey/SiteFooter';
import { SiteHeader } from '@/components/twokey/SiteHeader';
import { LoadingState } from '@/components/twokey/state-panels';
import { webEnv } from '@/lib/env';
import { HIJACK_USER_MESSAGE } from '@/lib/hijack';
import { EMPTY_ATTEMPT } from '@/lib/hijack-view';
import {
  FIXTURE_SESSION,
  fixtureHijackOutcome,
  fixtureHijackStatus,
  fixtureSteps,
  RATE_LIMITED_MESSAGE,
} from '@/lib/state-fixtures';
import { readForced } from '@/lib/test-states';
import { type ForcedHijack, HijackBox } from './hijack-box';

export const metadata: Metadata = { title: 'Hijack the agent · Two-Key' };

const FORCED = ['empty', 'loading', 'error', 'rate-limited', 'replay', 'caps', 'success'] as const;

/** `?__state=` screenshots only (lib/test-states.ts). */
function forcedHijack(forced: (typeof FORCED)[number]): ForcedHijack {
  const running = { kind: 'running', attemptId: FIXTURE_SESSION, startedAt: 0 } as const;
  const live = fixtureHijackStatus(true);
  switch (forced) {
    case 'empty':
      return { phase: { kind: 'idle' }, attempt: EMPTY_ATTEMPT, status: live };
    case 'loading':
      return { phase: running, attempt: { ...EMPTY_ATTEMPT, steps: fixtureSteps() }, status: live };
    case 'error':
      return {
        phase: { kind: 'finished' },
        attempt: { ...EMPTY_ATTEMPT, outcome: fixtureHijackOutcome('failed') },
        status: live,
      };
    case 'rate-limited':
      return {
        phase: { kind: 'refused', message: RATE_LIMITED_MESSAGE },
        attempt: EMPTY_ATTEMPT,
        status: { ...live, triesLeftThisHour: 0 },
      };
    case 'replay':
      return {
        phase: running,
        attempt: {
          ...EMPTY_ATTEMPT,
          replay: true,
          replayReason: REPLAY_REASON.slow,
          steps: fixtureSteps(),
        },
        status: live,
      };
    case 'caps':
      return {
        phase: { kind: 'finished' },
        attempt: {
          steps: fixtureSteps(),
          replay: true,
          replayReason: REPLAY_REASON.caps,
          outcome: fixtureHijackOutcome('replayed'),
        },
        status: fixtureHijackStatus(false),
      };
    case 'success':
      return {
        phase: { kind: 'finished' },
        attempt: {
          ...EMPTY_ATTEMPT,
          steps: fixtureSteps(),
          outcome: fixtureHijackOutcome('done'),
        },
        status: live,
      };
  }
}

async function Box({ searchParams }: { searchParams: PageProps<'/hijack'>['searchParams'] }) {
  await connection();
  const forced = readForced(await searchParams, FORCED);
  return (
    <HijackBox
      gatewayUrl={webEnv().GATEWAY_URL}
      forced={forced ? forcedHijack(forced) : undefined}
    />
  );
}

/** Public: anyone may try to talk the live agent into a purchase. The gate decides. */
export default function HijackPage(props: PageProps<'/hijack'>) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-8">
        <header className="flex max-w-3xl flex-col gap-2">
          <h1 className="text-2xl font-medium text-text">Try to hijack the agent</h1>
          <p className="text-base text-text">
            Write anything you like. It is pasted into one fictional store listing (Cloud Runner
            CR-1 at Peak Outfitters), and the live shopping agent is asked: “{HIJACK_USER_MESSAGE}”
          </p>
          <p className="text-sm text-text-muted">
            The signed rules allow Stride Supply, Peak Outfitters and Pacer Goods, up to $70, one
            item. If your text talks the agent into proposing something else, the gate decides what
            happens before PayPal is ever called.
          </p>
        </header>
        <Suspense fallback={<LoadingState rows={3} />}>
          <Box searchParams={props.searchParams} />
        </Suspense>
      </main>
      <SiteFooter />
    </>
  );
}
