import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { webEnv } from '@/lib/env';
import { requireUser } from '@/lib/session';
import { fixtureHistoryRows } from '@/lib/state-fixtures';
import { readForced } from '@/lib/test-states';
import { openAuthorizations } from './actions';
import { HistoryLive, type Load } from './live';

export const metadata: Metadata = { title: 'History · Two-Key' };

const FORCED = ['empty', 'loading', 'error', 'partial', 'success', 'crash'] as const;

/** `?__state=` screenshots only (lib/test-states.ts). */
function forcedLoad(forced: Exclude<(typeof FORCED)[number], 'crash'>): Load {
  if (forced === 'loading') return { status: 'loading' };
  if (forced === 'error') return { status: 'error' };
  if (forced === 'empty') return { status: 'ready', rows: [] };
  return { status: 'ready', rows: fixtureHistoryRows(forced) };
}

async function History({ searchParams }: { searchParams: PageProps<'/history'>['searchParams'] }) {
  await requireUser();
  const forced = readForced(await searchParams, FORCED);
  // Shows app/error.tsx, the page every unexpected render error ends on.
  if (forced === 'crash') throw new Error('Forced render error for the error-page screenshot');
  if (forced) {
    const open = forced === 'partial' ? 2 : forced === 'success' ? 0 : null;
    return (
      <HistoryLive
        gatewayUrl={webEnv().GATEWAY_URL}
        initialOpen={open}
        forcedLoad={forcedLoad(forced)}
      />
    );
  }
  const open = await openAuthorizations().catch(() => null);
  return <HistoryLive gatewayUrl={webEnv().GATEWAY_URL} initialOpen={open} />;
}

export default function HistoryPage(props: PageProps<'/history'>) {
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
        <History searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}
