import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { approvalById } from '@/app/approvals/actions';
import { PhoneApproval } from '@/app/approvals/live';
import { ErrorState, LoadingState } from '@/components/twokey/state-panels';
import type { ApprovalItem } from '@/lib/approvals-view';
import { webEnv } from '@/lib/env';
import { requireUser } from '@/lib/session';
import { fixtureApproval } from '@/lib/state-fixtures';
import { readForced } from '@/lib/test-states';

export const metadata: Metadata = { title: 'Approve purchase · Two-Key' };

const FORCED = ['loading', 'error', 'voided', 'elsewhere', 'success'] as const;

/** `?__state=` screenshots only (lib/test-states.ts). */
function forcedItem(forced: 'voided' | 'elsewhere' | 'success'): ApprovalItem {
  const decidedAt = new Date(Date.now() - 4 * 60_000).toISOString();
  if (forced === 'voided') {
    return fixtureApproval({
      status: 'timed_out',
      state: 'voided',
      decidedAt,
      decidedVia: 'timer',
    });
  }
  return fixtureApproval({
    status: 'approved',
    state: 'captured',
    decidedAt,
    decidedVia: forced === 'elsewhere' ? 'web' : 'phone',
  });
}

async function Card({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: PageProps<'/m/approve/[id]'>['searchParams'];
}) {
  await requireUser();
  const { id } = await params;
  const forced = readForced(await searchParams, FORCED);
  if (forced === 'loading') return <LoadingState rows={1} />;
  if (forced && forced !== 'error') {
    const fixture = forcedItem(forced);
    return <PhoneApproval gatewayUrl={webEnv().GATEWAY_URL} id={fixture.id} initial={fixture} />;
  }
  let item: Awaited<ReturnType<typeof approvalById>>;
  try {
    if (forced === 'error') throw new Error('forced');
    item = await approvalById(id);
  } catch {
    return (
      <ErrorState
        title="Couldn’t load this hold"
        body="Nothing was approved or denied. If you don’t decide in time, it is voided and you are not charged."
      />
    );
  }
  if (!item) {
    return (
      <ErrorState
        title="Hold not found"
        body="It may belong to another account. Your approvals inbox lists every hold waiting for you."
      />
    );
  }
  // Already decided, expired or voided holds render as a closed card with their outcome.
  return <PhoneApproval gatewayUrl={webEnv().GATEWAY_URL} id={id} initial={item} />;
}

export default function PhoneApprovePage(props: PageProps<'/m/approve/[id]'>) {
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col gap-5 px-4"
      style={{
        paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
      }}
    >
      <header className="flex items-center justify-between">
        <p className="text-sm font-medium text-text">Two-Key</p>
        <Link
          href="/approvals"
          className="inline-flex min-h-11 items-center text-sm text-accent underline-offset-4 hover:underline"
        >
          All approvals
        </Link>
      </header>
      <Suspense fallback={<LoadingState rows={1} />}>
        <Card params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}
