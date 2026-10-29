import type { Metadata } from 'next';
import Link from 'next/link';
import { ErrorPanel } from '@/components/twokey/error-panel';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Not found · Two-Key' };

/** Unknown pages, and resources that belong to another account (same answer: 404). */
export default function NotFound() {
  return (
    <ErrorPanel
      title="Page not found"
      body="This page doesn’t exist, or it belongs to another account."
      action={
        <Button asChild size="lg">
          <Link href="/">Home</Link>
        </Button>
      }
    />
  );
}
