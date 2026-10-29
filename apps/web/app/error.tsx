'use client';

import Link from 'next/link';
import { ErrorPanel, errorReference } from '@/components/twokey/error-panel';
import { Button } from '@/components/ui/button';

/** Any unexpected render error below the root layout. Never shows the original message. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <ErrorPanel
      title="This page didn’t load"
      body="Nothing was bought, approved or changed. Try again in a moment."
      reference={errorReference(error)}
      action={
        <>
          <Button size="lg" onClick={() => retry()}>
            Try again
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/">Home</Link>
          </Button>
        </>
      }
    />
  );
}
