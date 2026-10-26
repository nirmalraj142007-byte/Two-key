'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type PayPalIdKind = 'order' | 'authorization' | 'capture' | 'merchant' | 'debug';

const KIND_LABEL: Record<PayPalIdKind, string> = {
  order: 'PayPal order ID',
  authorization: 'PayPal authorization ID',
  capture: 'PayPal capture ID',
  merchant: 'PayPal merchant ID',
  debug: 'PayPal debug ID',
};

/** 'ABCDEFGHIJKLMNOP' -> 'ABCDEF…MNOP'; short IDs are shown whole. */
export function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function PayPalId({
  id,
  kind,
  className,
}: {
  id: string;
  kind: PayPalIdKind;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const label = KIND_LABEL[kind];

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span
      data-slot="paypal-id"
      className={cn('inline-flex items-center gap-0.5 pl-1.5 font-mono text-xs', className)}
    >
      {/* Screen readers get the full ID; sighted users get the short form plus a tooltip. */}
      <span className="sr-only">
        {label} {id}
      </span>
      <span aria-hidden="true" title={id} className="text-text-muted">
        {truncateId(id)}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy ${label}`}
            className="inline-flex size-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface hover:text-text"
          >
            {copied ? (
              <CheckIcon aria-hidden="true" className="size-3.5" />
            ) : (
              <CopyIcon aria-hidden="true" className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          Copy full ID: <span className="font-mono">{id}</span>
        </TooltipContent>
      </Tooltip>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}
