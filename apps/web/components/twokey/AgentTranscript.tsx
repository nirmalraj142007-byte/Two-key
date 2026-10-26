import { SearchIcon, ShieldAlertIcon, WrenchIcon } from 'lucide-react';
import { firstLine, type ListingHit, type StepEntry, searchHits } from '@/lib/console-view';
import { cn } from '@/lib/utils';

// Everything here is rendered as text: React escapes it, and nothing uses
// dangerouslySetInnerHTML. Listing text comes from third parties and may carry an injection.

function chipLabel(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  if (name === 'search_products' && typeof args.query === 'string') return `"${args.query}"`;
  if (name === 'propose_purchase') {
    const id = typeof args.product_id === 'string' ? args.product_id : '?';
    const short = id.length > 10 ? `…${id.slice(-6)}` : id;
    return `product ${short} · qty ${String(args.qty ?? '?')}`;
  }
  if (name === 'get_purchase_status') return 'checking a purchase';
  return '';
}

function ToolChip({ name, input }: { name: string; input: unknown }) {
  const label = chipLabel(name, input);
  return (
    <span
      data-slot="tool-chip"
      className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-border bg-surface px-2 py-0.5 font-mono text-xs text-text"
    >
      <WrenchIcon aria-hidden="true" className="size-3 shrink-0 text-text-muted" />
      <span className="shrink-0">{name}</span>
      {label ? <span className="truncate text-text-muted">{label}</span> : null}
    </span>
  );
}

function ListingTextBlock({ hit }: { hit: ListingHit }) {
  return (
    <figure
      data-slot="listing-text"
      data-injected="true"
      className="flex flex-col gap-1.5 rounded-md border-2 border-dashed border-state-blocked-fg/60 bg-surface p-3"
    >
      <figcaption className="flex items-center gap-1.5 text-xs font-medium text-text">
        <ShieldAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
        Text from a product listing · {hit.store}
      </figcaption>
      <blockquote className="whitespace-pre-wrap break-words font-mono text-xs text-text">
        {hit.listingText}
      </blockquote>
      <p className="text-xs text-text-muted">
        Written by the store, not by you. Two-Key never treats it as an instruction.
      </p>
    </figure>
  );
}

function SearchResult({ text }: { text: string }) {
  const hits = searchHits(text);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text">{firstLine(text)}</p>
      {hits.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-text-muted">
          {hits.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a result list is fixed once shown
            <li key={i} className="truncate">
              {h.title} · {h.store} · ${h.price}
            </li>
          ))}
        </ul>
      ) : null}
      {hits
        .filter((h) => h.injected)
        .map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a result list is fixed once shown
          <ListingTextBlock key={i} hit={h} />
        ))}
    </div>
  );
}

function Step({ entry }: { entry: StepEntry }) {
  if (entry.role === 'assistant') {
    const words = entry.text.trim() || entry.reasoning?.trim() || '';
    const searching = entry.toolCalls?.some((c) => c.name === 'search_products');
    return (
      <li data-slot="agent-step" data-role="assistant" className="flex flex-col gap-2">
        {searching ? (
          <p className="flex items-center gap-2 text-sm font-medium text-text">
            <SearchIcon aria-hidden="true" className="size-4 text-accent" />
            Searching your stores…
          </p>
        ) : null}
        {words ? (
          <blockquote className="border-l-2 border-border pl-3 text-sm italic text-text-muted">
            “{words.length > 600 ? `${words.slice(0, 599)}…` : words}”
          </blockquote>
        ) : null}
        {entry.toolCalls?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {entry.toolCalls.map((c) => (
              <ToolChip key={c.id} name={c.name} input={c.input} />
            ))}
          </div>
        ) : null}
      </li>
    );
  }
  if (entry.role === 'tool') {
    return (
      <li
        data-slot="agent-step"
        data-role="tool"
        className={cn(
          'flex flex-col gap-1 rounded-md bg-surface px-3 py-2',
          entry.isError && 'text-state-blocked-fg',
        )}
      >
        <span className="font-mono text-xs text-text-muted">{entry.toolName} →</span>
        {entry.toolName === 'search_products' && !entry.isError ? (
          <SearchResult text={entry.text} />
        ) : (
          <p className="text-sm text-text">{firstLine(entry.text)}</p>
        )}
      </li>
    );
  }
  if (entry.role === 'error') {
    return (
      <li data-slot="agent-step" data-role="error" className="text-sm text-state-blocked-fg">
        The agent stopped.
      </li>
    );
  }
  return null;
}

/** The agent's live steps: what it said, which tools it called and what came back. */
export function AgentTranscript({ steps, className }: { steps: StepEntry[]; className?: string }) {
  return (
    <ol
      data-slot="agent-transcript"
      aria-label="Agent steps"
      aria-live="polite"
      className={cn('flex flex-col gap-4', className)}
    >
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps are append-only
        <Step key={i} entry={s} />
      ))}
    </ol>
  );
}
