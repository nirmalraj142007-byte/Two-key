'use client';

import { CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** A labelled code block whose Copy button copies exactly the text shown. */
export function CodeBlock({ label, code }: { label: string; code: string }) {
  const copy = () =>
    navigator.clipboard.writeText(code).then(
      () => toast(`${label} copied`),
      () => toast('Copy failed — select the text and copy it'),
    );
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-sm font-medium text-text">{label}</figcaption>
        <Button variant="outline" size="sm" className="h-9 px-3" onClick={copy}>
          <CopyIcon aria-hidden="true" />
          Copy<span className="sr-only"> {label}</span>
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-sm text-text">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
