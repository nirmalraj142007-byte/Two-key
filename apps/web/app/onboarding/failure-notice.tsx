import { CircleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { Failure } from '@/lib/onboarding';

/** One plain sentence and one next action. A failure without a link is retried in place. */
export function FailureNotice({ failure, retry }: { failure: Failure; retry?: () => void }) {
  return (
    <div
      role="alert"
      data-slot="failure-notice"
      className="flex flex-col gap-3 rounded-md border border-text bg-surface-raised px-4 py-3 text-sm text-text sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="flex items-start gap-2">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {failure.message}
      </span>
      {failure.next.href ? (
        <Button asChild variant="outline" size="sm">
          <Link href={failure.next.href}>{failure.next.label}</Link>
        </Button>
      ) : retry ? (
        <Button variant="outline" size="sm" onClick={retry}>
          {failure.next.label}
        </Button>
      ) : null}
    </div>
  );
}
