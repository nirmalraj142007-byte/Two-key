import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { webEnv } from '@/lib/env';
import { requireUser } from '@/lib/session';
import { openAuthorizations } from './actions';
import { HistoryLive } from './live';

export const metadata: Metadata = { title: 'History · Two-Key' };

async function History() {
  await requireUser();
  const open = await openAuthorizations().catch(() => null);
  return <HistoryLive gatewayUrl={webEnv().GATEWAY_URL} initialOpen={open} />;
}

export default function HistoryPage() {
  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">History</h1>
        <p className="text-base text-text-muted">
          Every purchase the agent proposed, what Two-Key decided, and what PayPal did with it.
        </p>
        <nav className="flex gap-4 text-sm">
          <Link href="/agent" className="text-accent underline-offset-4 hover:underline">
            Agent console
          </Link>
          <Link href="/merchants" className="text-accent underline-offset-4 hover:underline">
            Merchant balances
          </Link>
        </nav>
      </header>
      <Suspense fallback={<LoadingState rows={4} />}>
        <History />
      </Suspense>
    </main>
  );
}
