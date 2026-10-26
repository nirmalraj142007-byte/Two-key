'use client';

import { ClockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const URGENT_MS = 10 * 60 * 1000;

/** Pure formatter: remaining milliseconds to "14:05", "1:02:09" or "0:00". */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Time left on a hold. Turns red under 10 minutes. The clock is read only in the browser,
 * so server and first client render match ("–:––").
 */
export function Countdown({
  deadline,
  className,
}: {
  deadline: Date | string | number;
  className?: string;
}) {
  const end = new Date(deadline).getTime();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = now === null ? null : end - now;
  const urgent = remaining !== null && remaining < URGENT_MS;
  const done = remaining !== null && remaining <= 0;

  return (
    <span
      data-slot="countdown"
      data-urgent={urgent || undefined}
      className={cn(
        'inline-flex items-center gap-1.5 text-sm tabular-nums',
        urgent ? 'font-medium text-state-blocked-fg' : 'text-text-muted',
        className,
      )}
    >
      <ClockIcon aria-hidden="true" className="size-3.5" />
      <time dateTime={new Date(end).toISOString()}>
        {remaining === null ? '–:––' : done ? 'Time is up' : `${formatRemaining(remaining)} left`}
      </time>
    </span>
  );
}
