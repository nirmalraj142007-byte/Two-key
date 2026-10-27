import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import type { ApprovalItem } from '@/lib/approvals-view';
import { webEnv } from '@/lib/env';
import { requireUser } from '@/lib/session';
import { pendingApprovals } from './actions';
import { ApprovalsInbox } from './live';
import { PushToggle } from './push-toggle';

export const metadata: Metadata = { title: 'Approvals · Two-Key' };

async function Inbox() {
  await requireUser();
  const items = await pendingApprovals().catch((): ApprovalItem[] | null => null);
  const env = webEnv();
  return (
    <>
      <PushToggle vapidPublicKey={env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null} />
      <ApprovalsInbox gatewayUrl={env.GATEWAY_URL} initial={items ?? []} failed={items === null} />
    </>
  );
}

export default function ApprovalsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Approvals</h1>
        <p className="text-base text-text-muted">
          Purchases Two-Key held because something looked unusual. The money is authorized but not
          taken until you approve.
        </p>
        <Link href="/agent" className="text-sm text-accent underline-offset-4 hover:underline">
          Back to the agent console
        </Link>
      </header>
      <Suspense fallback={<LoadingState rows={2} />}>
        <Inbox />
      </Suspense>
    </main>
  );
}
