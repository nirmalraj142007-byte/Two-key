import { HistoryIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BannerTone = 'info' | 'warning' | 'replay';

// Banners never use state colours (design rule 2); tone shows through icon, border and weight.
const TONE: Record<BannerTone, { icon: ReactNode; className: string }> = {
  info: {
    icon: <InfoIcon aria-hidden="true" className="size-4 shrink-0 text-accent" />,
    className: 'border-border bg-surface text-text',
  },
  warning: {
    icon: <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />,
    className: 'border-text bg-surface-raised font-medium text-text',
  },
  replay: {
    icon: <HistoryIcon aria-hidden="true" className="size-4 shrink-0" />,
    className: 'border-dashed border-text-muted bg-surface text-text',
  },
};

export function Banner({
  tone,
  text,
  className,
}: {
  tone: BannerTone;
  text: string;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <div
      data-slot="banner"
      data-tone={tone}
      role="status"
      className={cn(
        'flex items-center gap-3 rounded-md border px-4 py-3 text-sm',
        t.className,
        className,
      )}
    >
      {t.icon}
      <span>{text}</span>
    </div>
  );
}
