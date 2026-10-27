import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { webEnv } from '@/lib/env';
import type { MerchantBalance } from '@/lib/merchants-view';
import { requireUser } from '@/lib/session';
import { merchantBalances } from './actions';
import { MerchantBalances } from './live';

export const metadata: Metadata = { title: 'Merchants · Two-Key' };

async function Balances() {
  await requireUser();
  const items = await merchantBalances().catch((): MerchantBalance[] | null => null);
  return <MerchantBalances gatewayUrl={webEnv().GATEWAY_URL} initial={items} />;
}

export default function MerchantsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Merchants</h1>
        <p className="text-base text-text-muted">
          The five PayPal sandbox business accounts in the demo. A blocked purchase never reaches
          PayPal, so the attacker’s account receives nothing.
        </p>
        <nav className="flex gap-4 text-sm">
          <Link href="/history" className="text-accent underline-offset-4 hover:underline">
            Purchase history
          </Link>
          <Link href="/agent" className="text-accent underline-offset-4 hover:underline">
            Agent console
          </Link>
        </nav>
      </header>
      <Suspense fallback={<LoadingState rows={3} />}>
        <Balances />
      </Suspense>
    </main>
  );
}
