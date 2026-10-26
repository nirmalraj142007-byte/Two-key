'use client';

import { CircleAlertIcon, InboxIcon, InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const PANEL =
  'flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-raised px-6 py-10 text-center';

export function EmptyState({
  title,
  body,
  action,
  className,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section data-slot="empty-state" className={cn(PANEL, className)}>
      <InboxIcon aria-hidden="true" className="size-6 text-text-muted" />
      <h3 className="text-lg font-medium text-text">{title}</h3>
      <p className="max-w-md text-sm text-text-muted">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </section>
  );
}

export function LoadingState({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div
      data-slot="loading-state"
      role="status"
      aria-busy="true"
      className={cn('flex flex-col gap-3', className)}
    >
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => i).map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface-raised p-4"
        >
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  title,
  body,
  retry,
  className,
}: {
  title: string;
  body: string;
  retry?: () => void;
  className?: string;
}) {
  return (
    <section data-slot="error-state" role="alert" className={cn(PANEL, className)}>
      <CircleAlertIcon aria-hidden="true" className="size-6 text-text-muted" />
      <h3 className="text-lg font-medium text-text">{title}</h3>
      <p className="max-w-md text-sm text-text-muted">{body}</p>
      {retry ? (
        <Button variant="outline" onClick={retry} className="mt-1">
          Try again
        </Button>
      ) : null}
    </section>
  );
}

export function PartialNotice({ text, className }: { text: string; className?: string }) {
  return (
    <p
      data-slot="partial-notice"
      className={cn(
        'flex items-start gap-2 rounded-sm bg-surface px-3 py-2 text-sm text-text-muted',
        className,
      )}
    >
      <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </p>
  );
}
