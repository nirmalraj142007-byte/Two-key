'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Countdown } from '@/components/twokey/countdown';
import { ErrorState } from '@/components/twokey/state-panels';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Theme = 'system' | 'light' | 'dark';

/** Sets or clears data-theme on <html>; "System" follows prefers-color-scheme. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  return (
    <fieldset className="inline-flex items-center gap-1 rounded-md border border-border bg-surface p-1">
      <legend className="sr-only">Colour theme</legend>
      {(['system', 'light', 'dark'] as const).map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={theme === t}
          onClick={() => setTheme(t)}
          className={cn(
            'h-8 rounded-sm px-3 text-sm font-medium capitalize text-text-muted hover:text-text',
            theme === t && 'bg-surface-raised text-text shadow-sm',
          )}
        >
          {t}
        </button>
      ))}
    </fieldset>
  );
}

/** Deadlines are built in the browser so prerendering never reads the clock. */
export function CountdownDemo() {
  const [base, setBase] = useState<number | null>(null);
  useEffect(() => setBase(Date.now()), []);
  const rows: Array<[string, number]> = [
    ['More than 10 minutes', 14 * 60_000 + 30_000],
    ['Under 10 minutes', 9 * 60_000 + 5_000],
    ['Over an hour', 65 * 60_000],
    ['Ended', -1],
  ];
  return (
    <ul className="flex flex-col gap-3">
      {rows.map(([label, offset]) => (
        <li key={label} className="flex items-center justify-between gap-4">
          <span className="text-sm text-text-muted">{label}</span>
          {base === null ? (
            <span className="text-sm text-text-muted">–:––</span>
          ) : (
            <Countdown deadline={base + offset} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function ErrorDemo() {
  return (
    <ErrorState
      title="Couldn't load your purchases"
      body="Two-Key could not reach the server. Nothing was bought or changed."
      retry={() => toast('Retrying…')}
    />
  );
}

export function ToastDemo() {
  return (
    <Button
      variant="outline"
      onClick={() => toast.success('Rules signed. The agent can shop now.')}
    >
      Show a toast
    </Button>
  );
}
