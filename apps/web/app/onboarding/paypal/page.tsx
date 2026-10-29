import { AppError, ErrorCode } from '@twokey/core';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Banner } from '@/components/twokey/banner';
import { LoadingState } from '@/components/twokey/state-panels';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toFailure } from '@/lib/onboarding';
import { SAVED_MESSAGE } from '@/lib/onboarding-copy';
import { readForced } from '@/lib/test-states';
import { FailureNotice } from '../failure-notice';
import { getProgress } from '../progress';
import { ConnectPayPal } from './connect-button';

export const metadata: Metadata = { title: 'Connect PayPal · Two-Key' };

const FORCED = ['empty', 'loading', 'error', 'saved'] as const;

async function PayPalStep({
  searchParams,
}: {
  searchParams: PageProps<'/onboarding/paypal'>['searchParams'];
}) {
  const forced = readForced(await searchParams, FORCED);
  if (forced === 'empty') return <ConnectPayPal />;
  if (forced === 'loading') return <ConnectPayPal forced={{ pending: true }} />;
  if (forced === 'error') {
    const failure = toFailure(new AppError(ErrorCode.UPSTREAM_PAYPAL, 'PayPal error'), 'paypal');
    return <ConnectPayPal forced={{ failure }} />;
  }
  const progress = forced === 'saved' ? { vaultConnected: true } : await getProgress();
  if (progress === null) {
    return (
      <FailureNotice
        failure={{
          message: "We couldn't check your PayPal connection. Nothing was changed.",
          next: { label: 'Reload', href: '/onboarding/paypal' },
        }}
      />
    );
  }
  if (progress.vaultConnected) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="info" text={SAVED_MESSAGE} />
        <ConnectPayPal reconnect />
      </div>
    );
  }
  return <ConnectPayPal />;
}

export default function PayPalPage(props: PageProps<'/onboarding/paypal'>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Connect PayPal once</CardTitle>
        <CardDescription className="text-base">
          You approve your PayPal account one time, so future purchases inside your rules need no
          PayPal pop-up.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<LoadingState rows={1} />}>
          <PayPalStep searchParams={props.searchParams} />
        </Suspense>
      </CardContent>
    </Card>
  );
}
