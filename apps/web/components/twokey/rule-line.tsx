import { InfoIcon, PencilIcon, ShieldCheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Enforcement = 'enforced' | 'advisory' | 'default';

const ENFORCEMENT: Record<Enforcement, { text: string; icon: ReactNode; className: string }> = {
  enforced: {
    text: 'Enforced at payment',
    icon: <ShieldCheckIcon aria-hidden="true" className="size-3.5 text-accent" />,
    className: 'border-border bg-surface-raised text-text',
  },
  advisory: {
    text: "Agent's job — not checked by Two-Key",
    icon: <InfoIcon aria-hidden="true" className="size-3.5" />,
    className: 'border-border bg-surface text-text-muted',
  },
  default: {
    text: 'Default — edit',
    icon: <PencilIcon aria-hidden="true" className="size-3.5" />,
    className: 'border-dashed border-border bg-transparent text-text-muted',
  },
};

export function RuleLine({
  label,
  value,
  enforcement,
  className,
}: {
  label: string;
  value: ReactNode;
  enforcement: Enforcement;
  className?: string;
}) {
  const e = ENFORCEMENT[enforcement];
  return (
    <div
      data-slot="rule-line"
      data-enforcement={enforcement}
      className={cn(
        'flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-text-muted">{label}</span>
        <span className="text-base font-medium text-text">{value}</span>
      </div>
      <span
        className={cn(
          'inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap',
          e.className,
        )}
      >
        {e.icon}
        {e.text}
      </span>
    </div>
  );
}
