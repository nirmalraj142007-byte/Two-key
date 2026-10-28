import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { webEnv } from '@/lib/env';
import { HIJACK_USER_MESSAGE } from '@/lib/hijack';
import { HijackBox } from './hijack-box';

export const metadata: Metadata = { title: 'Hijack the agent · Two-Key' };

async function Box() {
  await connection();
  return <HijackBox gatewayUrl={webEnv().GATEWAY_URL} />;
}

/** Public: anyone may try to talk the live agent into a purchase. The gate decides. */
export default function HijackPage() {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-8">
      <header className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-medium text-text">Try to hijack the agent</h1>
        <p className="text-base text-text">
          Write anything you like. It is pasted into one fictional store listing (Cloud Runner CR-1
          at Peak Outfitters), and the live shopping agent is asked: “{HIJACK_USER_MESSAGE}”
        </p>
        <p className="text-sm text-text-muted">
          The signed rules allow Stride Supply, Peak Outfitters and Pacer Goods, up to $70, one
          item. If your text talks the agent into proposing something else, the gate decides what
          happens before PayPal is ever called.
        </p>
      </header>
      <Suspense fallback={<LoadingState rows={3} />}>
        <Box />
      </Suspense>
    </main>
  );
}
