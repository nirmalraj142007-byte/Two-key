import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { approvalById } from '@/app/approvals/actions';
import { PhoneApproval } from '@/app/approvals/live';
import { ErrorState, LoadingState } from '@/components/twokey/state-panels';
import { webEnv } from '@/lib/env';
import { requireUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Approve purchase · Two-Key' };

async function Card({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  let item: Awaited<ReturnType<typeof approvalById>>;
  try {
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
        <Card params={props.params} />
      </Suspense>
    </main>
  );
}
