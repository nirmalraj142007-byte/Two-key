import Link from 'next/link';
import type { ReactNode } from 'react';

/** The full-page error and not-found body: one sentence, one next action, and a reference. */
export function ErrorPanel({
  title,
  body,
  action,
  reference,
}: {
  title: string;
  body: string;
  action: ReactNode;
  reference?: string | undefined;
}) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-4 py-16">
      <p className="text-sm font-medium text-text-muted">
        <Link href="/" className="hover:text-accent">
          Two-Key
        </Link>
      </p>
      <h1 className="text-2xl font-medium text-text">{title}</h1>
      <p className="text-base text-text-muted">{body}</p>
      <div className="flex flex-wrap gap-3">{action}</div>
      {reference ? (
        <p className="text-xs text-text-muted">
          Request ID: <span className="font-mono">{reference}</span>
        </p>
      ) : null}
    </main>
  );
}

/** The digest Next attaches to server errors: the ID to match against server logs. */
export function errorReference(error: unknown): string | undefined {
  return error instanceof Error && 'digest' in error && typeof error.digest === 'string'
    ? error.digest
    : undefined;
}
