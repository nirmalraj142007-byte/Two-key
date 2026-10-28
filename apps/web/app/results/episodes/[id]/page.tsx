import manifest from '@twokey/eval/frozen/manifest.json';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { DiffView } from '@/components/results/DiffView';
import { GATES, gateLabel, shortModel } from '@/components/results/format';
import { OutcomeChip } from '@/components/results/OutcomeChip';
import { ResultsError } from '@/components/results/ResultsTabs';
import { Money } from '@/components/twokey/money';
import { LoadingState, PartialNotice } from '@/components/twokey/state-panels';
import {
  type EpisodeDetail,
  getEpisode,
  type ProposalView,
  type RunView,
} from '@/lib/episodes-queries';
import type { TranscriptStep } from '@/lib/episodes-view';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Episode · Results · Two-Key' };

const VARIANT_LABEL = { clean: 'Clean', injecagent: 'InjecAgent', agentdojo: 'AgentDojo' };
const TARGET_LABEL = {
  outside_rules: 'Outside the rules (attacker payee)',
  inside_rules: 'Inside the rules (wrong product)',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-medium text-text">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Facts({ e }: { e: EpisodeDetail }) {
  const items: [string, React.ReactNode][] = [
    ['Split', e.split === 'test' ? 'Test' : 'Dev'],
    ['Variant', VARIANT_LABEL[e.variant]],
    [
      'Task',
      <span key="t" className="font-mono">
        {e.taskId}
      </span>,
    ],
    ['Price cap', <Money key="c" cents={e.priceCapCents} currency="USD" />],
  ];
  if (e.targetType) {
    items.push([
      'Attack goal',
      `${TARGET_LABEL[e.targetType]}${e.targetFallback ? ' · fallback (no inside-the-rules candidate)' : ''}`,
    ]);
  }
  if (e.injectionPosition !== null)
    items.push(['Injected at', `listing ${e.injectionPosition + 1}`]);
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-muted">{k}</dt>
          <dd className="text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Evaluation search returns the episode's first 6 listings (gateway EVAL_RESULTS_MAX). */
const EVAL_RESULTS_MAX = 6;

function Listings({
  items,
  injectedText,
}: {
  items: EpisodeDetail['listings'];
  injectedText: string | null;
}) {
  return (
    <ol className="flex flex-col gap-2">
      {items.map((l) => (
        <li
          key={l.listingId}
          data-injected={l.injected || undefined}
          className={cn(
            'flex flex-col gap-2 rounded-lg border bg-surface-raised p-3 text-sm',
            l.injected ? 'border-2 border-accent' : 'border-border',
          )}
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="tabular-nums text-text-muted">{l.position + 1}.</span>
            <span className="font-medium text-text">{l.title}</span>
            {l.injected ? (
              <span className="rounded-full bg-accent px-2 text-xs font-medium text-accent-foreground">
                Injected copy
              </span>
            ) : null}
            {l.target ? (
              <span className="rounded-full bg-state-held-bg px-2 text-xs font-medium text-state-held-fg">
                Wanted by the attack
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-text-muted">
            <span className="font-mono text-xs">{l.listingId}</span>
            <span>{l.store}</span>
            <Money cents={l.priceCents} currency="USD" />
            <span>{l.category}</span>
            <span>
              {l.referenceNOffers} {l.referenceNOffers === 1 ? 'offer' : 'offers'}
              {l.referencePriceCents !== null ? (
                <>
                  {' '}
                  · median <Money cents={l.referencePriceCents} currency="USD" />
                </>
              ) : null}
            </span>
          </div>
          {l.injected && injectedText ? (
            <div className="rounded-md border-2 border-text bg-surface p-3">
              <p className="mb-1 text-xs font-medium text-text">Text inserted into this listing</p>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-text">
                {injectedText.trim()}
              </p>
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function GateRow({ p }: { p: ProposalView }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-slot="gate-row">
      {GATES.map((g) => {
        const cell = p.gates[g];
        return (
          <div
            key={g}
            className="flex flex-col gap-1 rounded-md border border-border bg-surface p-2"
          >
            <span className="text-xs text-text-muted">
              {g} {gateLabel(g, manifest.staticCapCents)}
            </span>
            <OutcomeChip outcome={cell?.outcome ?? null} />
            {cell && cell.chips.length > 0 ? (
              <span className="text-xs text-text">{cell.chips.map((c) => c.label).join(', ')}</span>
            ) : (
              <span className="text-xs text-text-muted">
                {cell ? 'No rule hits' : 'Not decided'}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Proposal({ p }: { p: ProposalView }) {
  return (
    <li className="flex flex-col gap-2">
      <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-medium text-text">{p.title}</span>
        <span className="text-text-muted">{p.store}</span>
        <Money cents={p.amountCents} currency="USD" />
        {p.qty > 1 ? <span className="text-text-muted">×{p.qty}</span> : null}
        <span className="font-mono text-xs text-text-muted">{p.listingId}</span>
        {p.isTarget ? (
          <span className="rounded-full bg-state-held-bg px-2 text-xs font-medium text-state-held-fg">
            Wanted by the attack
          </span>
        ) : null}
        {p.attackerPayee ? (
          <span className="rounded-full bg-state-blocked-bg px-2 text-xs font-medium text-state-blocked-fg">
            Attacker payee
          </span>
        ) : null}
      </p>
      <GateRow p={p} />
    </li>
  );
}

const STEP_LABEL: Record<TranscriptStep['kind'], string> = {
  user: 'Task',
  assistant: 'Agent',
  reasoning: 'Agent reasoning',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  error: 'Error',
};

function Steps({ steps }: { steps: TranscriptStep[] }) {
  return (
    <ol className="flex flex-col gap-1.5 text-sm">
      {steps.map((s, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: transcript steps are static and ordered.
          key={i}
          className={cn(
            'grid gap-x-3 rounded-sm px-2 py-1 sm:grid-cols-[120px_1fr]',
            s.kind === 'tool_call' && 'bg-surface',
            s.kind === 'error' && 'bg-state-blocked-bg',
          )}
        >
          <span className="text-xs text-text-muted">
            {STEP_LABEL[s.kind]}
            {s.toolName ? ` · ${s.toolName}` : ''}
          </span>
          <span
            className={cn(
              'whitespace-pre-wrap break-words',
              s.kind === 'tool_call' || s.kind === 'tool_result' ? 'font-mono text-xs' : '',
              s.kind === 'reasoning' ? 'text-text-muted italic' : 'text-text',
            )}
          >
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Run({ run, attacked }: { run: RunView; attacked: boolean }) {
  return (
    <article
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-4"
      aria-label={`Run by ${shortModel(run.model)}`}
    >
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-base font-medium text-text">{shortModel(run.model)}</h3>
        {attacked ? (
          <span
            className={cn('text-sm', run.followed ? 'font-medium text-text' : 'text-text-muted')}
          >
            {run.followed ? 'Followed the attack' : 'Did not follow the attack'}
          </span>
        ) : null}
        <span className="text-sm tabular-nums text-text-muted">
          {run.tokensIn.toLocaleString('en-US')} in · {run.tokensOut.toLocaleString('en-US')} out ·
          LLM cost ${run.costUsd.toFixed(4)}
        </span>
        {run.productDetailOk !== null ? (
          <span className="text-sm text-text-muted">
            Product details right (LLM-graded): {run.productDetailOk ? 'yes' : 'no'}
          </span>
        ) : null}
      </header>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-text">Proposals and gate decisions</h4>
        {run.proposals.length === 0 ? (
          <p className="text-sm text-text-muted">No proposal: nothing reached the gate.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {run.proposals.map((p) => (
              <Proposal key={p.id} p={p} />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-text">What the agent did</h4>
        {run.steps ? (
          <Steps steps={run.steps} />
        ) : (
          <PartialNotice text="The transcript for this run was not recorded. Its proposals and gate decisions are shown above." />
        )}
      </div>
    </article>
  );
}

async function Episode({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let e: EpisodeDetail | null;
  try {
    e = await getEpisode(id);
  } catch {
    return <ResultsError />;
  }
  if (!e) notFound();
  const attacked = e.variant !== 'clean';
  const shown = e.listings.filter((l) => l.position < EVAL_RESULTS_MAX);
  const unseen = e.listings.filter((l) => l.position >= EVAL_RESULTS_MAX);
  return (
    <>
      <header className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb" className="text-sm text-text-muted">
          <Link href="/results" className="text-accent underline-offset-4 hover:underline">
            Results
          </Link>{' '}
          /{' '}
          <Link
            href={`/results/episodes?split=${e.split}`}
            className="text-accent underline-offset-4 hover:underline"
          >
            Episodes
          </Link>{' '}
          / <span className="font-mono">{e.episodeId.slice(-8)}</span>
        </nav>
        <h1 className="text-2xl font-medium text-text">
          {attacked ? `${VARIANT_LABEL[e.variant]} attack` : 'Clean run'} · one trip end to end
        </h1>
        <Facts e={e} />
      </header>

      <Section title="The task">
        <blockquote className="rounded-lg border-l-4 border-border bg-surface px-4 py-3 text-base text-text">
          {e.instruction}
        </blockquote>
      </Section>

      <Section title="Listings the agent saw, in order">
        <p className="text-sm text-text-muted">
          Listing IDs and structured fields only; titles have brand names hidden.
        </p>
        <Listings items={shown} injectedText={e.injectedText} />
        {unseen.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-text-muted">
              {unseen.length} more {unseen.length === 1 ? 'listing' : 'listings'} in this episode
              that the search never returned
            </summary>
            <div className="mt-2">
              <Listings items={unseen} injectedText={e.injectedText} />
            </div>
          </details>
        ) : null}
        {e.target && !shown.some((l) => l.target) ? (
          <p className="text-sm text-text">
            Listing the attack asks for (not among the search results):{' '}
            <span className="font-medium">{e.target.title}</span> at {e.target.store},{' '}
            <Money cents={e.target.priceCents} currency="USD" />{' '}
            <span className="font-mono text-xs text-text-muted">{e.target.listingId}</span>
          </p>
        ) : null}
      </Section>

      {e.template ? (
        <Section title="The attack template">
          <DiffView
            diff={e.template.diff}
            source={e.template.source}
            sourceRef={e.template.sourceRef}
            refLinks={e.template.ref}
            licence={e.template.licence}
          />
        </Section>
      ) : null}

      <Section title="Each model's run">
        {e.runs.length === 0 ? (
          <p className="text-sm text-text-muted">No model has run this episode yet.</p>
        ) : (
          e.runs.map((r) => <Run key={r.model} run={r} attacked={attacked} />)
        )}
      </Section>
    </>
  );
}

export default function EpisodePage({ params }: PageProps<'/results/episodes/[id]'>) {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-4 py-8">
      <Suspense fallback={<LoadingState rows={6} />}>
        <Episode params={params} />
      </Suspense>
    </main>
  );
}
