import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoadingState } from '@/components/twokey/state-panels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  CANCELLED_MESSAGE,
  checkReturn,
  MISMATCH_MESSAGE,
  returnedSetupTokenId,
  SETUP_COOKIE,
} from '@/lib/onboarding';
import { requireUser } from '@/lib/session';
import { FailureNotice } from '../../failure-notice';
import { CompleteConnection, SavedConnection } from './complete';

export const metadata: Metadata = { title: 'Connecting PayPal · Two-Key' };

async function ReturnStep({
  searchParams,
}: {
  searchParams: PageProps<'/onboarding/paypal/return'>['searchParams'];
}) {
  const user = await requireUser();
  const query = await searchParams;
  const check = checkReturn({
    query,
    cookie: (await cookies()).get(SETUP_COOKIE)?.value,
    userId: user.userId,
  });

  if (check.kind === 'cancelled') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-base text-text">{CANCELLED_MESSAGE}</p>
        <Button asChild size="lg" className="w-fit">
          <Link href="/onboarding/paypal">Connect PayPal</Link>
        </Button>
      </div>
    );
  }
  if (check.kind === 'saved') return <SavedConnection />;
  if (check.kind === 'mismatch') {
    return (
      <FailureNotice
        failure={{
          message: MISMATCH_MESSAGE,
          next: { label: 'Start again', href: '/onboarding/paypal' },
        }}
      />
    );
  }
  const returned = returnedSetupTokenId(query);
  return <CompleteConnection query={returned ? { approval_token_id: returned } : {}} />;
}

export default function PayPalReturnPage(props: PageProps<'/onboarding/paypal/return'>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Connect PayPal once</CardTitle>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<LoadingState rows={1} />}>
          <ReturnStep searchParams={props.searchParams} />
        </Suspense>
      </CardContent>
    </Card>
  );
}
