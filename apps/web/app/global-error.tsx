'use client';

import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { ErrorPanel, errorReference } from '@/components/twokey/error-panel';
import { Button } from '@/components/ui/button';
import './globals.css';

/** Replaces the root layout when it fails, so it brings its own document and styles. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <title>Something went wrong · Two-Key</title>
        <ErrorPanel
          title="Two-Key didn’t load"
          body="Nothing was bought, approved or changed. Try again in a moment."
          reference={errorReference(error)}
          action={
            <Button size="lg" onClick={() => retry()}>
              Try again
            </Button>
          }
        />
      </body>
    </html>
  );
}
