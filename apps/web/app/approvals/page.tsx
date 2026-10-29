import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { type ApprovalItem, isValidVapidKey } from '@/lib/approvals-view';
import { webEnv } from '@/lib/env';
import { requireUser } from '@/lib/session';
import { fixtureApproval } from '@/lib/state-fixtures';
import { readForced } from '@/lib/test-states';
import { pendingApprovals } from './actions';
import { ApprovalsInbox } from './live';
import { PushToggle } from './push-toggle';

export const metadata: Metadata = { title: 'Approvals · Two-Key' };

const FORCED = ['empty', 'loading', 'error', 'partial', 'success'] as const;
const URGENT_MS = 8 * 60_000;

/** `?__state=` screenshots only (lib/test-states.ts). */
function forcedItems(forced: (typeof FORCED)[number]): ApprovalItem[] | null {
  if (forced === 'error') return null;
  if (forced === 'partial') {
    return [fixtureApproval({ deadlineAt: new Date(Date.now() + URGENT_MS).toISOString() })];
  }
  if (forced === 'success') {
    return [
      fixtureApproval({
        status: 'approved',
        state: 'captured',
        decidedAt: new Date(Date.now() - 60_000).toISOString(),
        decidedVia: 'web',
      }),
    ];
  }
  return [];
}

async function Inbox({ searchParams }: { searchParams: PageProps<'/approvals'>['searchParams'] }) {
  await requireUser();
  const forced = readForced(await searchParams, FORCED);
  if (forced === 'loading') return <LoadingState rows={2} />;
  const items = forced
    ? forcedItems(forced)
    : await pendingApprovals().catch((): ApprovalItem[] | null => null);
  const env = webEnv();
  return (
    <>
      <PushToggle
        vapidPublicKey={
          isValidVapidKey(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
            ? env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
            : null
        }
      />
      <ApprovalsInbox gatewayUrl={env.GATEWAY_URL} initial={items ?? []} failed={items === null} />
    </>
  );
}

export default function ApprovalsPage(props: PageProps<'/approvals'>) {
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
        <Inbox searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}
