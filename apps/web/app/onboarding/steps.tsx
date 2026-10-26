'use client';

import { CheckIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface Progress {
  vaultConnected: boolean;
  activeCardId: string | null;
}

const STEPS = [
  { n: 1, label: 'Connect PayPal', href: '/onboarding/paypal', match: '/onboarding/paypal' },
  { n: 2, label: 'Your rules', href: '/rules/new', match: '/rules' },
  { n: 3, label: 'Your agent', href: '/onboarding/agent', match: '/onboarding/agent' },
] as const;

/** Shown while /human/me loads: the same labels, no state and no URL read. */
export function StepsPlaceholder() {
  return (
    <ol aria-hidden="true" className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
      {STEPS.map((step, i) => (
        <li key={step.n} className="flex items-center gap-2 text-text-muted">
          {i > 0 ? <span>·</span> : null}
          <span className="inline-flex items-center gap-2 px-2 py-1">
            <span className="inline-flex size-5 items-center justify-center rounded-full border border-border text-xs">
              {step.n}
            </span>
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Connect PayPal · Your rules · Your agent. `progress` is null when /human/me failed. */
export function ProgressSteps({ progress }: { progress: Progress | null }) {
  const pathname = usePathname();
  const done = [progress?.vaultConnected ?? false, Boolean(progress?.activeCardId), false];
  return (
    <nav aria-label="Setup progress">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
        {STEPS.map((step, i) => {
          const current = pathname.startsWith(step.match);
          const complete = done[i] === true;
          return (
            <li key={step.n} className="flex items-center gap-2">
              {i > 0 ? (
                <span aria-hidden="true" className="text-text-muted">
                  ·
                </span>
              ) : null}
              <Link
                href={step.href}
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md px-2 py-1 text-text-muted hover:text-text',
                  current && 'bg-surface-raised font-medium text-text',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-flex size-5 items-center justify-center rounded-full border border-border text-xs',
                    complete && 'border-accent bg-accent text-bg',
                  )}
                >
                  {complete ? <CheckIcon className="size-3" /> : step.n}
                </span>
                {step.label}
                {complete ? <span className="sr-only"> (done)</span> : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
