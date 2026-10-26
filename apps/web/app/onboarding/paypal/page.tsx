import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Banner } from '@/components/twokey/banner';
import { LoadingState } from '@/components/twokey/state-panels';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SAVED_MESSAGE } from '@/lib/onboarding-copy';
import { FailureNotice } from '../failure-notice';
import { getProgress } from '../progress';
import { ConnectPayPal } from './connect-button';

export const metadata: Metadata = { title: 'Connect PayPal · Two-Key' };

async function PayPalStep() {
  const progress = await getProgress();
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

export default function PayPalPage() {
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
          <PayPalStep />
        </Suspense>
      </CardContent>
    </Card>
  );
}
